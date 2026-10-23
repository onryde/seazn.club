// Resend's delivery events moved onto the outbox row (spec docs/superpowers/specs/2026-10-19-email-outbox-design.md, "The
// webhook"; plan Task 5). `applyProviderEvent(type, data)` is the whole of it: match a row, apply the monotonic rule, run the
// kind's hook when the row ended badly.
//
// THE RULEBOOK the expectations below are written from (never read back from the code under test):
//   - a late `delivered` after `delayed` wins; a late `delayed` after `delivered` is ignored;
//   - bounced, complained, failed and suppressed are final (they never move again);
//   - an accepted ruling: `complained` / `bounced` MAY overwrite `delivered`, because a complaint arrives after delivery;
//   - `replaced`, `expired` and `dead` never move;
//   - an unknown provider id is a no-op (200 at the route), and so is an event type nobody tracks.
//
// Three groups: the vocabulary (no database), the transition matrix (every status x every event, on a real Postgres), and the
// sequences the house rules owe (a duplicate, an out-of-order pair, two events racing, a webhook that beats the send's own
// response, the outbox tag found through the REAL transport's request body).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { randomUUID } from "node:crypto";
import { sql, statementCount } from "@/lib/db";

const logMock = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }));
vi.mock("@/server/logger", () => ({ log: logMock }));

import { dispatchNow } from "../attempt";
import { OUTBOX_KINDS, OUTBOX_STATUSES, OUTBOX_TAG_NAME, type OutboxKind, type OutboxStatus } from "../constants";
import { enqueueEmail } from "../enqueue";
import { KIND_HOOKS, type EndedRow } from "../hooks";
import { PROVIDER_EVENT_STATUS, STATUS_RANK, UNMOVABLE_STATUSES, applyProviderEvent } from "../provider-events";
import { runOutboxTick } from "../worker";

const HAS_DB = !!process.env.DATABASE_URL;
const RUN = `t5-${randomUUID().slice(0, 8)}`;
const KEK = "ab".repeat(32);
const API_KEY = "re_t5_test";
/** A provider id unique to this run: provider_id is unique across the table. */
const pid = (s: string): string => `re_${s}_${RUN}`;

// Resend's webhook event names and the status each means, written out from the spec (the order is the order of the matrix
// rows' columns below).
const EVENTS = [
  "email.delivered",
  "email.delivery_delayed",
  "email.bounced",
  "email.complained",
  "email.failed",
  "email.suppressed",
] as const;
type EventName = (typeof EVENTS)[number];
const EVENT_TO_STATUS: Record<EventName, OutboxStatus> = {
  "email.delivered": "delivered",
  "email.delivery_delayed": "delayed",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.failed": "failed",
  "email.suppressed": "suppressed",
};
const FINAL_EVENTS = ["email.bounced", "email.complained", "email.failed", "email.suppressed"] as const;

/**
 * Status after each event, row by row, hand-written from the rulebook above (the columns are EVENTS in order):
 *   delivered, delivery_delayed, bounced, complained, failed, suppressed.
 * A row only moves up: queued/sending/sent can take anything; delayed takes delivered and the finals but not delayed again;
 * delivered takes only the finals (a late `delayed` and a repeated `delivered` change nothing); a final status, and
 * replaced / expired / dead, take nothing.
 */
const OPEN = ["delivered", "delayed", "bounced", "complained", "failed", "suppressed"] as const;
const MATRIX: Record<OutboxStatus, readonly OutboxStatus[]> = {
  queued: OPEN,
  sending: OPEN,
  sent: OPEN,
  delayed: ["delivered", "delayed", "bounced", "complained", "failed", "suppressed"],
  delivered: ["delivered", "delivered", "bounced", "complained", "failed", "suppressed"],
  bounced: Array(6).fill("bounced") as OutboxStatus[],
  complained: Array(6).fill("complained") as OutboxStatus[],
  failed: Array(6).fill("failed") as OutboxStatus[],
  suppressed: Array(6).fill("suppressed") as OutboxStatus[],
  expired: Array(6).fill("expired") as OutboxStatus[],
  dead: Array(6).fill("dead") as OutboxStatus[],
  replaced: Array(6).fill("replaced") as OutboxStatus[],
};

describe("the vocabulary (no database)", () => {
  it("the event map names exactly the six events the spec tracks, each to the status the spec says", () => {
    expect(Object.keys(PROVIDER_EVENT_STATUS).sort()).toEqual([...EVENTS].sort());
    for (const ev of EVENTS) expect(PROVIDER_EVENT_STATUS[ev], ev).toBe(EVENT_TO_STATUS[ev]);
    expect(EVENTS.length).toBe(6);
  });

  it("every status is either ranked or one of the three that never move, never both: a thirteenth status forces a decision", () => {
    const ranked = Object.keys(STATUS_RANK) as OutboxStatus[];
    expect(ranked.filter((s) => (UNMOVABLE_STATUSES as readonly string[]).includes(s))).toEqual([]);
    expect([...ranked, ...UNMOVABLE_STATUSES].sort()).toEqual([...OUTBOX_STATUSES].sort());
    expect([...UNMOVABLE_STATUSES].sort()).toEqual(["dead", "expired", "replaced"]);
    // Anti-vacuity: twelve statuses were classified.
    expect(ranked.length + UNMOVABLE_STATUSES.length).toBe(OUTBOX_STATUSES.length);
    expect(OUTBOX_STATUSES.length).toBe(12);
  });

  it("the ranks are the spec's ladder: queued/sending < sent < delayed < delivered < the four final statuses (equal)", () => {
    expect(STATUS_RANK.queued).toBe(STATUS_RANK.sending);
    expect(STATUS_RANK.sending).toBeLessThan(STATUS_RANK.sent);
    expect(STATUS_RANK.sent).toBeLessThan(STATUS_RANK.delayed);
    expect(STATUS_RANK.delayed).toBeLessThan(STATUS_RANK.delivered);
    for (const s of ["bounced", "complained", "failed", "suppressed"] as const) {
      expect(STATUS_RANK[s], s).toBeGreaterThan(STATUS_RANK.delivered);
      expect(STATUS_RANK[s], s).toBe(STATUS_RANK.bounced);
    }
  });

  it("the matrix covers every status and its rows are as long as the event list (so a new status or event reds here first)", () => {
    expect(Object.keys(MATRIX).sort()).toEqual([...OUTBOX_STATUSES].sort());
    for (const [from, row] of Object.entries(MATRIX)) expect(row.length, from).toBe(EVENTS.length);
  });

  it("an event type nobody tracks is 'not_tracked' without touching the database, whatever the id says", async () => {
    const types = ["email.sent", "email.opened", "email.clicked", "email.received", "email.scheduled", "domain.created", "", "constructor", "__proto__", "toString", "hasOwnProperty"];
    const before = statementCount();
    for (const t of types) expect(await applyProviderEvent(t, { email_id: "re_x", tags: { [OUTBOX_TAG_NAME]: randomUUID() } }), t).toBe("not_tracked");
    expect(types.length).toBe(11);
    expect(statementCount() - before).toBe(0);
  });
});

describe.skipIf(!HAS_DB)("Resend delivery events on the outbox row (DB)", () => {
  const savedHooks = {} as Record<OutboxKind, (typeof KIND_HOOKS)[OutboxKind]>;
  // One spy PER KIND (round 1): with a single shared spy a webhook that fired the wrong kind's hook would still read as
  // "the hook ran". `hookSpy` is the default kind's (rows seed as magic_link unless a test says otherwise).
  const spies = Object.fromEntries(OUTBOX_KINDS.map((k) => [k, vi.fn<(row: EndedRow) => Promise<void>>(async () => {})])) as Record<
    OutboxKind,
    Mock<(row: EndedRow) => Promise<void>>
  >;
  const hookSpy = spies.magic_link;
  const anyHookCalls = (): number => OUTBOX_KINDS.reduce((n, k) => n + spies[k].mock.calls.length, 0);

  type Row = {
    id: string;
    kind: string;
    ref_type: string;
    ref_id: string;
    meta: Record<string, string>;
    recipient: string;
    body_sealed: Buffer | null;
    status: string;
    attempts: number;
    lease_until: Date | null;
    provider_id: string | null;
    last_error: string | null;
    status_at: Date;
    next_attempt_at: Date;
    sent_at: Date | null;
  };
  const get = async (id: string): Promise<Row> => {
    const [r] = await sql<Row[]>`select * from email_outbox where id = ${id}`;
    if (!r) throw new Error(`no outbox row ${id}`);
    return r;
  };

  /**
   * A row in `status`, written as the privileged role with its CHECKs satisfied: a body and no lease while `queued`, a
   * body and a lease while `sending`, neither otherwise. `status_at` is an hour old so a move is visible as a fresher time
   * and an ignored event as an unchanged one.
   */
  async function seed(status: OutboxStatus, over: { providerId?: string | null; statusAt?: Date; kind?: OutboxKind } = {}): Promise<{ id: string; providerId: string | null }> {
    const id = randomUUID();
    const providerId = over.providerId === undefined ? pid(randomUUID()) : over.providerId;
    const retryable = status === "queued" || status === "sending";
    await sql`
      insert into email_outbox
        (id, kind, ref_type, ref_id, meta, recipient, subject, body_sealed, transactional, status, attempts, lease_until,
         expires_at, provider_id, status_at)
      values
        (${id}, ${over.kind ?? "magic_link"}, ${over.kind === "chess_invite" ? "board_seat" : "login"}, ${`${RUN}-${randomUUID()}`}, ${sql.json({ seat: "white" })}, ${`${randomUUID()}@x.test`},
         'Your sign-in link', ${retryable ? Buffer.from("sealed-body") : null}, true, ${status}, ${status === "queued" ? 0 : 1},
         ${status === "sending" ? new Date(Date.now() + 120_000) : null}, now() + interval '15 minutes', ${providerId},
         ${over.statusAt ?? new Date(Date.now() - 3_600_000)})`;
    return { id, providerId };
  }
  /** Did the status change just now? (`status_at` is what phase 2 reads as "when".) */
  const movedJustNow = (r: Row): boolean => Date.now() - r.status_at.getTime() < 60_000;

  const hooksOn = () => {
    for (const k of OUTBOX_KINDS) KIND_HOOKS[k] = { onEndedBadly: spies[k] };
  };

  beforeAll(async () => {
    await sql`select 1`;
  });
  afterAll(async () => {
    await sql`delete from email_outbox where ref_id like ${`${RUN}-%`}`;
    await sql.end({ timeout: 2 }).catch(() => undefined);
  });
  beforeEach(() => {
    vi.stubEnv("LICHESS_TOKEN_KEK", KEK);
    vi.stubEnv("RESEND_API_KEY", API_KEY);
    logMock.error.mockClear();
    logMock.warn.mockClear();
    logMock.info.mockClear();
    for (const k of OUTBOX_KINDS) spies[k].mockClear();
    for (const k of OUTBOX_KINDS) savedHooks[k] = KIND_HOOKS[k];
    hooksOn();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    for (const k of OUTBOX_KINDS) KIND_HOOKS[k] = savedHooks[k];
  });

  // ---- every status x every event -------------------------------------------------------------------------------------

  it("every status x every event: 12 x 6 = 72 cells; a row only moves up, an ignored event leaves the whole row untouched, a move nulls body and lease", async () => {
    let checked = 0;
    let moves = 0;
    let ignores = 0;
    for (const from of OUTBOX_STATUSES) {
      for (const [i, ev] of EVENTS.entries()) {
        const want = MATRIX[from][i]!;
        const { id, providerId } = await seed(from);
        const before = await get(id);
        const answer = await applyProviderEvent(ev, { email_id: providerId });
        const after = await get(id);
        const label = `${from} + ${ev}`;

        expect(after.status, label).toBe(want);
        if (want !== from) {
          expect(answer, label).toBe("moved");
          expect(after.body_sealed, `${label}: body`).toBeNull();
          expect(after.lease_until, `${label}: lease`).toBeNull();
          expect(movedJustNow(after), `${label}: status_at`).toBe(true);
          expect(after.provider_id, label).toBe(providerId);
          moves++;
        } else {
          expect(answer, label).toBe("ignored");
          expect(after, `${label}: nothing about the row changed`).toEqual(before);
          ignores++;
        }
        checked++;
      }
    }
    expect(checked).toBe(OUTBOX_STATUSES.length * EVENTS.length);
    expect(checked).toBe(72);
    // Both kinds of cell really occurred, so neither half of the assertion above was skipped.
    expect(moves).toBeGreaterThan(0);
    expect(ignores).toBeGreaterThan(0);
    expect(moves + ignores).toBe(72);
  });

  it("the spec's named cases, each on its own (a final to a final does not move; a complaint after delivery does)", async () => {
    const cases: [from: OutboxStatus, event: EventName, to: OutboxStatus][] = [
      ["delayed", "email.delivered", "delivered"],
      ["delivered", "email.delivery_delayed", "delivered"],
      ["bounced", "email.delivered", "bounced"],
      ["failed", "email.bounced", "failed"],
      ["suppressed", "email.complained", "suppressed"],
      ["delivered", "email.complained", "complained"],
      ["sent", "email.delivery_delayed", "delayed"],
      ["replaced", "email.delivered", "replaced"],
      ["expired", "email.delivered", "expired"],
      ["dead", "email.delivered", "dead"],
    ];
    for (const [from, ev, to] of cases) {
      const { id, providerId } = await seed(from);
      await applyProviderEvent(ev, { email_id: providerId });
      expect((await get(id)).status, `${from} + ${ev}`).toBe(to);
    }
    expect(cases.length).toBe(10);
  });

  // ---- the kind hook --------------------------------------------------------------------------------------------------

  it.each(FINAL_EVENTS)("a move into the status of %s runs the row's OWN kind's hook once (every kind), with the row's ids and meta and no recipient", async (ev) => {
    let checked = 0;
    for (const kind of OUTBOX_KINDS) {
      for (const k of OUTBOX_KINDS) spies[k].mockClear();
      const { id, providerId } = await seed("sent", { kind });
      expect(await applyProviderEvent(ev, { email_id: providerId }), kind).toBe("moved");
      const row = await get(id);
      expect(spies[kind], kind).toHaveBeenCalledTimes(1);
      expect(spies[kind].mock.calls[0]![0], kind).toEqual({ id, kind, refType: row.ref_type, refId: row.ref_id, status: EVENT_TO_STATUS[ev], meta: { seat: "white" } });
      expect(JSON.stringify(spies[kind].mock.calls[0]![0])).not.toContain(row.recipient);
      // Kind-correct: no OTHER kind's hook heard about this row.
      for (const other of OUTBOX_KINDS.filter((o) => o !== kind)) expect(spies[other], `${kind} row must not fire ${other}`).not.toHaveBeenCalled();
      expect(anyHookCalls()).toBe(1);
      checked++;
    }
    expect(checked).toBe(OUTBOX_KINDS.length);
    expect(OUTBOX_KINDS.length).toBeGreaterThanOrEqual(2); // a second kind really exists to be confused with the first
  });

  it("a move into delivered or delayed does not run the hook; an ignored duplicate of a bad ending does not run it again", async () => {
    const a = await seed("sent");
    expect(await applyProviderEvent("email.delivery_delayed", { email_id: a.providerId })).toBe("moved");
    expect(await applyProviderEvent("email.delivered", { email_id: a.providerId })).toBe("moved");
    expect(hookSpy).not.toHaveBeenCalled();
    // afterEndedBadly itself refuses a row that did not end badly (and logs an error): the webhook must not even ask it.
    expect(logMock.error).not.toHaveBeenCalled();

    const b = await seed("sent");
    expect(await applyProviderEvent("email.bounced", { email_id: b.providerId })).toBe("moved");
    expect(hookSpy).toHaveBeenCalledTimes(1);
    expect(await applyProviderEvent("email.bounced", { email_id: b.providerId })).toBe("ignored");
    expect(await applyProviderEvent("email.complained", { email_id: b.providerId })).toBe("ignored");
    expect(hookSpy).toHaveBeenCalledTimes(1); // still once: a retried webhook does not release a seat twice
  });

  it("a hook that throws is logged and swallowed: the row is already moved and the answer is still 'moved'", async () => {
    for (const k of OUTBOX_KINDS) KIND_HOOKS[k] = { onEndedBadly: async () => { throw new Error("hook exploded"); } };
    const { id, providerId } = await seed("sent");
    expect(await applyProviderEvent("email.failed", { email_id: providerId })).toBe("moved");
    expect((await get(id)).status).toBe("failed");
    expect(logMock.error).toHaveBeenCalled(); // positive pair: it was reported, not silently dropped
  });

  // ---- matching: provider id, then the outbox tag ---------------------------------------------------------------------

  it("an unknown email_id is 'unknown' and changes no row; so does a missing, empty or non-string one, even when a valid outbox tag names a live row", async () => {
    const free = await seed("queued", { providerId: null });
    const mine = [await seed("sent"), await seed("delayed"), free];
    const snapshot = async () => Promise.all(mine.map((m) => get(m.id)));
    const before = await snapshot();
    const tags = { [OUTBOX_TAG_NAME]: free.id }; // would match `free` if the id were usable: it must not be, without an email_id
    const cases: Record<string, unknown>[] = [
      { email_id: pid("nobody") },
      {},
      { email_id: "" },
      { email_id: 42 },
      { email_id: null },
      { email_id: ["a"] },
      { tags },
      { email_id: "", tags },
      { email_id: 42, tags },
      { email_id: null, tags },
      { email_id: ["a"], tags },
    ];
    for (const data of cases) expect(await applyProviderEvent("email.delivered", data), JSON.stringify(data)).toBe("unknown");
    expect(cases.length).toBe(11);
    expect(await snapshot()).toEqual(before);
    expect(hookSpy).not.toHaveBeenCalled();
  });

  it("a provider id match wins over a tag that names a different row", async () => {
    const x = await seed("sent");
    const y = await seed("sent", { providerId: null });
    expect(await applyProviderEvent("email.delivered", { email_id: x.providerId, tags: { [OUTBOX_TAG_NAME]: y.id } })).toBe("moved");
    expect((await get(x.id)).status).toBe("delivered");
    expect((await get(y.id)).status).toBe("sent");
    expect((await get(y.id)).provider_id).toBeNull();
  });

  it.each([
    ["object map", (id: string) => ({ [OUTBOX_TAG_NAME]: id })],
    ["array of {name, value}", (id: string) => [{ name: OUTBOX_TAG_NAME, value: id }]],
  ])("timeout-then-accepted (%s tags): a queued row with no provider id is found by its outbox tag, moves, and gets the provider id", async (_n, tags) => {
    const { id } = await seed("queued", { providerId: null });
    const email = pid(randomUUID());
    expect(await applyProviderEvent("email.delivered", { email_id: email, tags: tags(id) })).toBe("moved");
    const r = await get(id);
    expect([r.status, r.provider_id, r.body_sealed, r.lease_until]).toEqual(["delivered", email, null, null]);
    expect(movedJustNow(r)).toBe(true);
    // The id is now the row's own: the next event for it needs no tag.
    expect(await applyProviderEvent("email.complained", { email_id: email })).toBe("moved");
    expect((await get(id)).status).toBe("complained");
  });

  it("a tag match is also found for a 'sending' row (an attempt still in flight): it moves and its lease goes", async () => {
    const { id } = await seed("sending", { providerId: null });
    expect(await applyProviderEvent("email.delivered", { email_id: pid("s"), tags: { [OUTBOX_TAG_NAME]: id } })).toBe("moved");
    const r = await get(id);
    expect([r.status, r.lease_until, r.body_sealed]).toEqual(["delivered", null, null]);
  });

  it("a tag is not trusted when it cannot be: a row that already has a different provider id, a tag under another name, a non-uuid, a uuid nobody holds", async () => {
    const owned = await seed("sent"); // has provider_id
    const free = await seed("queued", { providerId: null });
    const before = [await get(owned.id), await get(free.id)];
    const email = pid("stranger");
    const cases: Record<string, unknown>[] = [
      { email_id: email, tags: { [OUTBOX_TAG_NAME]: owned.id } }, // the row already has another provider id
      { email_id: email, tags: { other: free.id } }, // another tag name
      { email_id: email, tags: [{ name: "other", value: free.id }] },
      { email_id: email, tags: { [OUTBOX_TAG_NAME]: "not-a-uuid" } }, // would be a cast error in SQL
      { email_id: email, tags: [{ name: OUTBOX_TAG_NAME, value: "'; drop table email_outbox; --" }] },
      { email_id: email, tags: { [OUTBOX_TAG_NAME]: randomUUID() } }, // a uuid no row holds
      { email_id: email, tags: { [OUTBOX_TAG_NAME]: 7 } },
      { email_id: email, tags: [null, 3, "x", { name: OUTBOX_TAG_NAME }, { value: free.id }] },
      { email_id: email, tags: "outbox" },
      { email_id: email, tags: null },
    ];
    for (const data of cases) expect(await applyProviderEvent("email.delivered", data), JSON.stringify(data)).toBe("unknown");
    expect(cases.length).toBe(10);
    expect([await get(owned.id), await get(free.id)]).toEqual(before);
  });

  it("a tag match on a row that cannot move is 'ignored' and does not write the provider id", async () => {
    const { id } = await seed("dead", { providerId: null });
    expect(await applyProviderEvent("email.delivered", { email_id: pid("late"), tags: { [OUTBOX_TAG_NAME]: id } })).toBe("ignored");
    const r = await get(id);
    expect([r.status, r.provider_id]).toEqual(["dead", null]);
  });

  // ---- sequences ------------------------------------------------------------------------------------------------------

  it("a duplicate event (Resend retried the webhook): the first moves, the second is ignored, and the row is the same as after the first", async () => {
    const { id, providerId } = await seed("sent");
    expect(await applyProviderEvent("email.delivered", { email_id: providerId })).toBe("moved");
    const afterFirst = await get(id);
    expect(await applyProviderEvent("email.delivered", { email_id: providerId })).toBe("ignored");
    expect(await get(id)).toEqual(afterFirst);
  });

  it("out of order: a late delivered after delayed wins; a late delayed after delivered is ignored; the order the events ARRIVE decides nothing the rank does not", async () => {
    const a = await seed("sent");
    expect(await applyProviderEvent("email.delivery_delayed", { email_id: a.providerId })).toBe("moved");
    expect(await applyProviderEvent("email.delivered", { email_id: a.providerId })).toBe("moved");
    expect((await get(a.id)).status).toBe("delivered");
    expect(await applyProviderEvent("email.delivery_delayed", { email_id: a.providerId })).toBe("ignored");
    expect((await get(a.id)).status).toBe("delivered");

    // Delivered before delayed ever arrived (the webhook's retries reorder them): same end state, one move.
    const b = await seed("sent");
    expect(await applyProviderEvent("email.delivered", { email_id: b.providerId })).toBe("moved");
    expect(await applyProviderEvent("email.delivery_delayed", { email_id: b.providerId })).toBe("ignored");
    expect((await get(b.id)).status).toBe("delivered");
  });

  it("every order of four events (24 permutations): the first FINAL event to arrive wins and nothing after it moves the row", async () => {
    const order = ["email.delivery_delayed", "email.delivered", "email.complained", "email.bounced"] as const;
    const perms = (xs: readonly string[]): string[][] => (xs.length <= 1 ? [[...xs]] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])));
    let checked = 0;
    for (const p of perms(order)) {
      const { id, providerId } = await seed("sent");
      for (const ev of p) await applyProviderEvent(ev, { email_id: providerId });
      // The first final event to arrive wins (finals never move): bounced or complained, whichever came first.
      const firstFinal = p.find((e) => e === "email.complained" || e === "email.bounced")!;
      expect((await get(id)).status, p.join(" > ")).toBe(EVENT_TO_STATUS[firstFinal as EventName]);
      checked++;
    }
    expect(checked).toBe(24);
  });

  describe("two events racing for one row (a real overlap, not a hope)", () => {
    /** Poll until `ok()` or fail after ~8 s: a barrier that never opens must fail the test, not hang it. */
    const until = async (what: string, ok: () => Promise<boolean>): Promise<void> => {
      for (let i = 0; i < 160; i++) {
        if (await ok()) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`timed out waiting for ${what}`);
    };
    /** Webhook UPDATEs currently blocked on a row lock (the statement text is this module's own, so no other suite matches). */
    const blockedUpdates = async (): Promise<number> => {
      const [r] = await sql<{ n: number }[]>`
        select count(*)::int as n from pg_stat_activity
         where wait_event_type = 'Lock' and query like '%update email_outbox%status_at = greatest(status_at, now())%'`;
      return r!.n;
    };

    /**
     * Another connection holds the row's lock; `first` and then `second` are fired and BOTH are seen waiting at their UPDATE
     * (so their finds, which read no lock, have already run against the same `sent` row); only then is the lock released.
     * Each UPDATE re-reads the row after its wait, which is what the where clause's status rule is for.
     */
    async function race(first: EventName, second: EventName) {
      const { id, providerId } = await seed("sent");
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let locked!: () => void;
      const hasLock = new Promise<void>((r) => (locked = r));
      const blocker = sql.begin(async (tx) => {
        await tx`select id from email_outbox where id = ${id} for update`;
        locked();
        await gate;
      });
      try {
        await hasLock;
        const base = await blockedUpdates();
        const a = applyProviderEvent(first, { email_id: providerId });
        await until("the first UPDATE to block", async () => (await blockedUpdates()) === base + 1);
        const b = applyProviderEvent(second, { email_id: providerId });
        await until("the second UPDATE to block", async () => (await blockedUpdates()) === base + 2);
        const bothBlocked = (await blockedUpdates()) - base; // read just before the release: the overlap really happened
        release();
        await blocker;
        return { id, results: await Promise.all([a, b]), bothBlocked };
      } finally {
        release();
        await blocker.catch(() => undefined);
      }
    }

    it.each([
      // delayed's UPDATE runs first (sent -> delayed), delivered's re-reads `delayed` and moves it up: both move.
      ["email.delivery_delayed", "email.delivered", ["moved", "moved"], "delivered"],
      // delivered's UPDATE runs first; delayed's re-reads `delivered` and must NOT move it back: one move, one ignore.
      ["email.delivered", "email.delivery_delayed", ["moved", "ignored"], "delivered"],
      // a final status beats a delivered, whichever UPDATE ran first.
      ["email.complained", "email.delivered", ["moved", "ignored"], "complained"],
      ["email.delivered", "email.complained", ["moved", "moved"], "complained"],
      // two events of the SAME rank: a final status never moves again, so the second must lose, not overwrite the first.
      ["email.bounced", "email.complained", ["moved", "ignored"], "bounced"],
      ["email.complained", "email.bounced", ["moved", "ignored"], "complained"],
      // the same event twice at once (Resend's retry overlapping the first delivery of it): one move, one ignore.
      ["email.delivered", "email.delivered", ["moved", "ignored"], "delivered"],
    ] as [EventName, EventName, string[], OutboxStatus][])("%s then %s, both blocked at their UPDATE together -> %j and the row ends %s", async (first, second, expected, ends) => {
      const { id, results, bothBlocked } = await race(first, second);
      // Anti-vacuity: the two statements were genuinely waiting on the same row at the same moment.
      expect(bothBlocked).toBe(2);
      expect(results).toEqual(expected);
      expect((await get(id)).status).toBe(ends);
    });
  });

  it("status_at never moves backwards: a row whose status_at is ahead of the database clock keeps the later time when it moves", async () => {
    const { id, providerId } = await seed("sent", { statusAt: new Date(Date.now() + 3_600_000) });
    const before = await get(id);
    expect(await applyProviderEvent("email.delivered", { email_id: providerId })).toBe("moved");
    const after = await get(id);
    expect(after.status).toBe("delivered");
    expect(after.status_at.getTime()).toBe(before.status_at.getTime());
  });

  it("the log carries the event type and ids and never the recipient or the raw payload", async () => {
    const { id, providerId } = await seed("sent");
    const recipient = (await get(id)).recipient;
    await applyProviderEvent("email.bounced", { email_id: providerId, to: [recipient], from: "RAW-FROM@secret.test", subject: "RAW-SUBJECT" });
    const logged = JSON.stringify([logMock.error.mock.calls, logMock.warn.mock.calls, logMock.info.mock.calls]);
    expect(logMock.info).toHaveBeenCalled(); // positive pair: it logged something to scan
    expect(logged).toContain("email.bounced");
    expect(logged).not.toContain(recipient);
    expect(logged).not.toContain("RAW-FROM");
    expect(logged).not.toContain("RAW-SUBJECT");
  });

  // ---- through the real producer: the transport's own request body ----------------------------------------------------

  describe("through the real transport (fetch is the only stub)", () => {
    type Sent = { body: { tags: { name: string; value: string }[]; subject: string }; headers: Record<string, string> };
    const sentRequests: Sent[] = [];
    let respond: (req: Sent) => Promise<Response>;
    const fetchStub = vi.fn(async (_url: string, init: RequestInit) => {
      const req: Sent = { body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> };
      sentRequests.push(req);
      return respond(req);
    });
    let messageId = "";
    const okResponse = (id: string) => new Response(JSON.stringify({ id }), { status: 200 });

    beforeEach(() => {
      messageId = pid(randomUUID());
      sentRequests.length = 0;
      fetchStub.mockClear();
      respond = async () => okResponse(messageId);
      vi.stubGlobal("fetch", fetchStub);
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => vi.restoreAllMocks());

    async function queue(): Promise<string> {
      return enqueueEmail(sql, {
        kind: "magic_link",
        refType: "login",
        refId: `${RUN}-${randomUUID()}`,
        orgId: null,
        to: `${randomUUID()}@x.test`,
        subject: "Your sign-in link",
        html: "<a href='https://seazn.club/v?token=T'>Sign in</a>",
        text: "Sign in",
        transactional: true,
        expiresAt: new Date(Date.now() + 15 * 60_000),
      });
    }
    /** Resend echoes a message's tags back as a name -> value map; the send request carries them as [{name, value}]. */
    const echoedTags = (req: Sent): Record<string, string> => Object.fromEntries(req.body.tags.map((t) => [t.name, t.value]));

    it("the tag the sender attaches is the tag the webhook reads: sent -> delivered -> a late delayed -> complained, through dispatchNow", async () => {
      const id = await queue();
      expect((await dispatchNow([id])).get(id)).toBe("sent");
      expect(sentRequests[0]!.body.tags).toEqual([{ name: OUTBOX_TAG_NAME, value: id }]);
      expect((await get(id)).provider_id).toBe(messageId);

      expect(await applyProviderEvent("email.delivered", { email_id: messageId, tags: echoedTags(sentRequests[0]!) })).toBe("moved");
      expect((await get(id)).status).toBe("delivered");
      expect(await applyProviderEvent("email.delivery_delayed", { email_id: messageId, tags: echoedTags(sentRequests[0]!) })).toBe("ignored");
      expect((await get(id)).status).toBe("delivered");
      expect(await applyProviderEvent("email.complained", { email_id: messageId, tags: echoedTags(sentRequests[0]!) })).toBe("moved");
      expect((await get(id)).status).toBe("complained");
      expect(hookSpy).toHaveBeenCalledTimes(1);
      expect(hookSpy.mock.calls[0]![0]).toMatchObject({ id, status: "complained" });
    });

    it.each([
      ["object map (what a webhook delivers)", (req: Sent) => echoedTags(req)],
      ["array (what the send request carries)", (req: Sent) => req.body.tags],
    ])("timeout-then-accepted, %s: the request left but its answer was lost; the row retries; the webhook finds it by the tag and the worker never sends it again", async (_n, shape) => {
      respond = async () => {
        throw new TypeError("fetch failed"); // Resend accepted it; we never saw the 200
      };
      const id = await queue();
      expect((await dispatchNow([id])).get(id)).toBe("retrying");
      const retrying = await get(id);
      expect([retrying.status, retrying.provider_id, retrying.attempts]).toEqual(["queued", null, 1]);
      expect(retrying.body_sealed).not.toBeNull();

      const tags = shape(sentRequests[0]!);
      expect(await applyProviderEvent("email.delivered", { email_id: messageId, tags })).toBe("moved");
      const done = await get(id);
      expect([done.status, done.provider_id, done.body_sealed, done.attempts]).toEqual(["delivered", messageId, null, 1]);

      // The row is no longer due: a tick that is scoped to it, made due by hand, sends nothing.
      await sql`update email_outbox set next_attempt_at = now() - interval '1 minute' where id = ${id}`;
      await runOutboxTick({ onlyIds: [id] });
      expect(fetchStub).toHaveBeenCalledTimes(1);
      expect((await get(id)).status).toBe("delivered");
    });

    it("a webhook that beats the send's own response: the row stays delivered with the provider id, and the attempt's late result is fenced out (not written over it)", async () => {
      const id = await queue();
      let answer: string | undefined;
      respond = async (req) => {
        // Mid-flight: the row is 'sending' and has no provider id; the event arrives before the 200 is processed.
        expect((await get(id)).status).toBe("sending");
        answer = await applyProviderEvent("email.delivered", { email_id: messageId, tags: echoedTags(req) });
        return okResponse(messageId);
      };
      const outcome = (await dispatchNow([id])).get(id);
      expect(answer).toBe("moved");
      // The attempt's own write is conditional on the row still being 'sending': it found it moved and recorded nothing.
      expect(outcome).toBe("deferred");
      const r = await get(id);
      expect([r.status, r.provider_id, r.lease_until, r.body_sealed]).toEqual(["delivered", messageId, null, null]);
    });
  });
});
