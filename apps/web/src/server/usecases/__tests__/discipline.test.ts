// PROMPT-78 — discipline fold/detection/serving (SPEC-1). DB-backed; skipped
// without DATABASE_URL. Seeds a football division with raw SQL, drops
// attributed card events into the ledger, and asserts the recompute-on-read
// fold: accumulation buckets, dismissal, idempotency, void un-count, anonymous
// exclusion, and the derived serving counter.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// The suspension notices are rows on the email outbox (phase 3 wave 4, kinds `suspension_confirmed`, `suspension_served`). The outbox's one
// network seam is captured, never sent; the row, the seal, the gate and the attempt are the real ones. `enqueueEmailOnce`
// is WRAPPED (the real insert runs) so a test can count how often a producer asked for a notice, which the once-key
// alone would hide (a second ask writes no second row).
const transport = vi.hoisted(() => ({ deliver: vi.fn() }));
vi.mock("@/server/email-outbox/transport", () => ({ deliver: transport.deliver }));
vi.mock("@/server/email-outbox", async (io) => {
  const m = await io<typeof import("@/server/email-outbox")>();
  return { ...m, enqueueEmailOnce: vi.fn(m.enqueueEmailOnce) };
});

import { sql, withTenant } from "@/lib/db";
import { enqueueEmailOnce } from "@/server/email-outbox";
import { MAX_EXPIRY_MS, idempotencyKey, type OutboxKind, type OutboxStatus } from "@/server/email-outbox/constants";
import { bornAgo, dictionarySubject } from "@/server/email-outbox/__tests__/_kind-harness";
import { runOutboxTick } from "@/server/email-outbox/worker";
import { stubOutboxEnv } from "./_invite-mail";
import { PaymentRequiredError } from "@/lib/errors";
import {
  activePublicSuspensionEntries,
  activeSuspensionsByEntrant,
  createManualSuspension,
  decideSuspension,
  detectSuspensions,
  getDisciplineRules,
  listSuspensions,
  publicSuspensions,
  putDisciplineRules,
  queueSuspensionConfirmed,
  queueSuspensionServed,
} from "../discipline";
import { refreshDiscipline, scoreEvent } from "../scoring";

import { claimPerson, makeFixture, seedFootballDivision, type FootballCtx as Ctx } from "./_seed";
const HAS_DB = !!process.env.DATABASE_URL;

const RULES = {
  accumulation: [
    { key: "yellow_5", color: "yellow", count: 5, ban_matches: 1 },
    { key: "yellow_10", color: "yellow", count: 10, ban_matches: 2 },
  ],
  dismissal: [
    { key: "second_yellow", color: "second_yellow", ban_matches: 1 },
    { key: "red", color: "red", ban_matches: 1 },
  ],
};

async function setRules(ctx: Ctx, rules: unknown = RULES, enabled = true): Promise<void> {
  await sql`
    insert into discipline_rules (org_id, division_id, enabled, rules)
    values (${ctx.orgId}, ${ctx.divisionId}, ${enabled}, ${sql.json(rules as never)})
    on conflict (division_id) do update set enabled = excluded.enabled, rules = excluded.rules`;
}

const seqByFixture = new Map<string, number>();
function nextSeq(fixtureId: string): number {
  const n = (seqByFixture.get(fixtureId) ?? 0) + 1;
  seqByFixture.set(fixtureId, n);
  return n;
}

async function insertCard(
  ctx: Ctx,
  fixtureId: string,
  by: string,
  person: string | null,
  color: string,
  recordedAt?: string,
  // S4 (#428) — the Law 12 offence (CardReason), so a rule can be scoped to
  // ONE offence rather than to the colour alone.
  reason?: string,
): Promise<string> {
  const payload = { by, ...(person ? { person } : {}), color, ...(reason ? { reason } : {}) };
  const [{ id }] = await sql<{ id: string }[]>`
    insert into score_events (fixture_id, org_id, seq, type, payload, recorded_at)
    values (${fixtureId}, ${ctx.orgId}, ${nextSeq(fixtureId)}, 'football.card', ${sql.json(payload)},
            coalesce(${recordedAt ?? null}::timestamptz, now()))
    returning id`;
  return id;
}

async function voidEvent(ctx: Ctx, fixtureId: string, targetId: string): Promise<void> {
  await sql`
    insert into score_events (fixture_id, org_id, seq, type, payload, voids_event_id)
    values (${fixtureId}, ${ctx.orgId}, ${nextSeq(fixtureId)}, 'core.void', ${sql.json({})}, ${targetId})`;
}

async function detect(ctx: Ctx): Promise<void> {
  await withTenant(ctx.orgId, (tx) => detectSuspensions(tx, ctx.divisionId));
}

// The suspension notices on the email outbox (phase 3 wave 4). A notice is a row about ONE ban (`suspension / <id>`),
// at most once per fact (once-key `<id>:confirmed` / `<id>:served`), addressed to the claimed player's ACCOUNT
// (`recipient_user_id`), in their language (D4: the account's, then the org's default, then `en`). Expected subjects
// come from the emails dictionary on disk (`dictionarySubject`), never from the code under test.
type NoticeRow = {
  id: string; kind: OutboxKind; ref_type: string; ref_id: string; dedupe_key: string | null; org_id: string | null;
  recipient: string; recipient_user_id: string | null; transactional: boolean; subject: string; status: OutboxStatus;
  attempts: number; created_at: Date; expires_at: Date;
};
/** Every `kind` notice about the ban `banId`, oldest first. */
const noticesOf = (kind: OutboxKind, banId: string) =>
  sql<NoticeRow[]>`
    select id, kind, ref_type, ref_id, dedupe_key, org_id, recipient, recipient_user_id, transactional, subject, status,
           attempts, created_at, expires_at
      from email_outbox where kind = ${kind} and ref_type = 'suspension' and ref_id = ${banId}
     order by created_at, id`;
/** The notices once the request's own first attempt (a deferred `dispatchNow`) is over: none left queued or sending. */
const settledNoticesOf = async (kind: OutboxKind, banId: string) => {
  await vi.waitFor(
    async () => {
      const rows = await noticesOf(kind, banId);
      expect(rows.filter((r) => r.status === "queued" || r.status === "sending"), "the request's first attempt is over").toEqual([]);
    },
    { timeout: 15_000, interval: 100 },
  );
  return noticesOf(kind, banId);
};
/** How many times a producer asked the outbox for a `kind` notice about `banId` (the wrapped `enqueueEmailOnce`). */
const asksFor = (kind: OutboxKind, banId: string): number =>
  vi.mocked(enqueueEmailOnce).mock.calls.filter(([, m]) => m.kind === kind && m.refId === banId).length;
/** The transport calls a row made (its idempotency key names the row). */
const sendsOf = (rowId: string): number =>
  transport.deliver.mock.calls.filter((c) => (c[0] as { idempotencyKey: string }).idempotencyKey === idempotencyKey(rowId)).length;
const address = (tag: string) => `${tag}-${randomUUID().slice(0, 8)}@test.local`;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("discipline fold (SPEC-1, PROMPT-78)", () => {
  beforeEach(() => {
    // The outbox seals the body and the gate lets the attempt through; the transport answers as Resend would.
    stubOutboxEnv();
    transport.deliver.mockReset();
    transport.deliver.mockImplementation(async () => ({ ok: true, providerId: `re_test_${randomUUID()}` }));
    vi.mocked(enqueueEmailOnce).mockClear();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("(a) 5 yellows raise one pending yellow_5 row; detection is idempotent", async () => {
    const ctx = await seedFootballDivision();
    await setRules(ctx);
    const fx = await makeFixture(ctx, 1, ctx.entrantA, ctx.entrantB);
    for (let i = 0; i < 5; i++) await insertCard(ctx, fx, ctx.entrantA, ctx.personX, "yellow");

    await detect(ctx);
    await detect(ctx);
    await detect(ctx);

    const rows = await listSuspensions(ctx.auth, ctx.divisionId);
    const acc = rows.filter((r) => r.source === "auto_accumulation");
    expect(acc).toHaveLength(1);
    expect(acc[0]!.status).toBe("pending");
    expect(acc[0]!.reason).toContain("yellow");
    const [meta] = await sql<{ rule_key: string; bucket: number }[]>`
      select rule_key, bucket from suspensions where id = ${acc[0]!.id}`;
    expect(meta).toEqual({ rule_key: "yellow_5", bucket: 1 });
  });

  it("(b) the 10th yellow raises a second row at bucket 2", async () => {
    const ctx = await seedFootballDivision();
    await setRules(ctx);
    const fx = await makeFixture(ctx, 1, ctx.entrantA, ctx.entrantB);
    for (let i = 0; i < 10; i++) await insertCard(ctx, fx, ctx.entrantA, ctx.personX, "yellow");

    await detect(ctx);
    const acc = (await listSuspensions(ctx.auth, ctx.divisionId)).filter(
      (r) => r.source === "auto_accumulation",
    );
    expect(acc).toHaveLength(2);
    const meta = await sql<{ rule_key: string; bucket: number }[]>`
      select rule_key, bucket from suspensions where division_id = ${ctx.divisionId}
        and source = 'auto_accumulation' order by bucket`;
    expect(meta).toEqual([
      { rule_key: "yellow_5", bucket: 1 },
      { rule_key: "yellow_10", bucket: 2 },
    ]);
  });

  it("(c) a red card raises an auto_dismissal row", async () => {
    const ctx = await seedFootballDivision();
    await setRules(ctx);
    const fx = await makeFixture(ctx, 1, ctx.entrantA, ctx.entrantB);
    await insertCard(ctx, fx, ctx.entrantA, ctx.personX, "red");

    await detect(ctx);
    const dis = (await listSuspensions(ctx.auth, ctx.divisionId)).filter(
      (r) => r.source === "auto_dismissal",
    );
    expect(dis).toHaveLength(1);
    expect(dis[0]!.status).toBe("pending");
    const [meta] = await sql<{ rule_key: string; bucket: number }[]>`
      select rule_key, bucket from suspensions where id = ${dis[0]!.id}`;
    expect(meta).toEqual({ rule_key: "red", bucket: 1 });
  });

  it("(d) voiding a trigger deletes a pending row but only flags a confirmed one", async () => {
    // pending path: void a trigger yellow → total 4 → pending row deleted.
    const a = await seedFootballDivision();
    await setRules(a);
    const fxA = await makeFixture(a, 1, a.entrantA, a.entrantB);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await insertCard(a, fxA, a.entrantA, a.personX, "yellow"));
    await detect(a);
    expect(
      (await listSuspensions(a.auth, a.divisionId)).filter((r) => r.source === "auto_accumulation"),
    ).toHaveLength(1);
    await voidEvent(a, fxA, ids[0]!);
    await detect(a);
    expect(
      (await listSuspensions(a.auth, a.divisionId)).filter((r) => r.source === "auto_accumulation"),
    ).toHaveLength(0);

    // confirmed path: confirm the row, THEN void a trigger → row stays, flagged.
    const b = await seedFootballDivision();
    await setRules(b);
    const fxB = await makeFixture(b, 1, b.entrantA, b.entrantB);
    const bIds: string[] = [];
    for (let i = 0; i < 5; i++)
      bIds.push(await insertCard(b, fxB, b.entrantA, b.personX, "yellow"));
    await detect(b);
    const pending = (await listSuspensions(b.auth, b.divisionId)).find(
      (r) => r.source === "auto_accumulation",
    )!;
    await decideSuspension(b.auth, pending.id, { kind: "confirm" });
    await voidEvent(b, fxB, bIds[0]!);
    await detect(b);
    const after = (await listSuspensions(b.auth, b.divisionId)).find((r) => r.id === pending.id)!;
    expect(after.status).toBe("active");
    expect(after.triggerVoided).toBe(true);
  });

  it("(e) anonymous cards accumulate nothing", async () => {
    const ctx = await seedFootballDivision();
    await setRules(ctx);
    const fx = await makeFixture(ctx, 1, ctx.entrantA, ctx.entrantB);
    for (let i = 0; i < 6; i++) await insertCard(ctx, fx, ctx.entrantA, null, "yellow");

    await detect(ctx);
    expect(await listSuspensions(ctx.auth, ctx.divisionId)).toHaveLength(0);
  });

  it("(f) serving counts decided + forfeit-by, never abandoned/pre-ban/forfeit-by-opponent", async () => {
    const ctx = await seedFootballDivision();
    await setRules(ctx, {
      accumulation: [{ key: "yellow_5", color: "yellow", count: 5, ban_matches: 3 }],
      dismissal: [],
    });
    const cardFx = await makeFixture(ctx, 1, ctx.entrantA, ctx.entrantB);
    for (let i = 0; i < 5; i++) await insertCard(ctx, cardFx, ctx.entrantA, ctx.personX, "yellow");
    await detect(ctx);
    const pending = (await listSuspensions(ctx.auth, ctx.divisionId)).find(
      (r) => r.source === "auto_accumulation",
    )!;
    const confirmed = await decideSuspension(ctx.auth, pending.id, {
      kind: "confirm",
    });
    expect(confirmed.status).toBe("active");
    expect(confirmed.entrantId).toBe(ctx.entrantA);

    // Stamp a fixture's deciding event; "after"/"before" the ban's decided_at.
    const stamp = async (
      fixtureId: string,
      type: string,
      payload: object,
      when: "after" | "before",
    ) => {
      await sql`
        insert into score_events (fixture_id, org_id, seq, type, payload, recorded_at)
        values (${fixtureId}, ${ctx.orgId}, ${nextSeq(fixtureId)}, ${type}, ${sql.json(payload as never)},
                ${when === "after" ? sql`now() + interval '1 hour'` : sql`now() - interval '1 day'`})`;
    };

    const fx1 = await makeFixture(ctx, 2, ctx.entrantA, ctx.entrantB, "decided");
    await stamp(fx1, "core.note", { text: "d" }, "after");
    const fx2 = await makeFixture(ctx, 3, ctx.entrantB, ctx.entrantA, "decided");
    await stamp(fx2, "core.note", { text: "d" }, "after");
    const fx3 = await makeFixture(ctx, 4, ctx.entrantA, ctx.entrantB, "forfeited");
    await stamp(fx3, "core.forfeit", { by: ctx.entrantA, reason: "walkover" }, "after");
    const fx4 = await makeFixture(ctx, 5, ctx.entrantA, ctx.entrantB, "abandoned");
    await stamp(fx4, "core.abandon", { reason: "rain" }, "after");
    const fx5 = await makeFixture(ctx, 6, ctx.entrantA, ctx.entrantB, "decided");
    await stamp(fx5, "core.note", { text: "old" }, "before");
    const fx6 = await makeFixture(ctx, 7, ctx.entrantA, ctx.entrantB, "forfeited");
    await stamp(fx6, "core.forfeit", { by: ctx.entrantB, reason: "walkover" }, "after");

    const served = (await listSuspensions(ctx.auth, ctx.divisionId)).find(
      (r) => r.id === pending.id,
    )!;
    expect(served.matchesServed).toBe(3); // fx1 + fx2 + fx3 (forfeit-by-A)
    expect(served.status).toBe("served");
  });

  /** Loop R M-9 (owner ruling 126, 2026-10-13): a double walkover counts as a match SERVED by a suspended entrant —
   *  `by: "both"` includes her. Every fixture is written through the console's own door (`scoreEvent`), after the
   *  ban was confirmed, except the two legacy chess rows, which only a pre-W2b ledger holds (the write door refuses
   *  `boardgame.result{double_forfeit}` now, D15). Each case on its own ban of 5 (so a count is never capped), the cap
   *  on a ban of 1. single-sport: football — the counter reads statuses and outcomes, never the sport; the chess rows
   *  are a ledger shape, written raw. */
  it("ruling 126: a double walkover serves 1 for the suspended entrant; a forfeit by the opponent 0; a forfeit by her 1; capped at matches_total; a legacy chess double forfeit 1; voided, a double walkover or her forfeit serves 0", async () => {
    async function banned(ban: number) {
      const ctx = await seedFootballDivision();
      await setRules(ctx, { accumulation: [{ key: "yellow_5", color: "yellow", count: 5, ban_matches: ban }], dismissal: [] });
      await sql`update divisions set status = 'active' where id = ${ctx.divisionId}`;
      const cardFx = await makeFixture(ctx, 1, ctx.entrantA, ctx.entrantB);
      for (let i = 0; i < 5; i++) await insertCard(ctx, cardFx, ctx.entrantA, ctx.personX, "yellow");
      await detect(ctx);
      const pending = (await listSuspensions(ctx.auth, ctx.divisionId)).find((r) => r.source === "auto_accumulation")!;
      const confirmed = await decideSuspension(ctx.auth, pending.id, { kind: "confirm" });
      expect([confirmed.status, confirmed.entrantId, confirmed.matchesTotal], "rig: A's ban is active").toEqual(["active", ctx.entrantA, ban]);
      return { ctx, id: pending.id };
    }
    const forfeit = (ctx: Ctx, fx: string, by: string) =>
      scoreEvent(ctx.auth, fx, { expected_seq: 0, type: "core.forfeit", payload: { by, reason: "walkover" } } as never);
    /** Loop R2 N-4: the forfeit, then the console's Undo of it — the ledger keeps both events, the fixture is unplayed
     *  again; the counter reads the ACTIVE ledger only (2026-10-27), so the voided forfeit names nobody and is no start —
     *  and the stored status, back to scheduled, agrees. */
    const forfeitThenVoid = async (ctx: Ctx, fx: string, by: string) => {
      const done = (await forfeit(ctx, fx, by)) as { event_id: string };
      await scoreEvent(ctx.auth, fx, { expected_seq: 1, type: "core.void", payload: { event_id: done.event_id } } as never);
      const [row] = await sql<{ status: string; outcome: unknown }[]>`select status, outcome from fixtures where id = ${fx}`;
      expect([row!.status, row!.outcome], `rig: the voided forfeit (by ${by === "both" ? "both" : "her"}) leaves the line unplayed`).toEqual(["scheduled", null]);
    };
    /** A pre-W2b chess double forfeit (`boardgame.result{double_forfeit}`, no core.forfeit): held `decided` where it
     *  was never refolded, `forfeited` (outcome double_walkover, append-event.ts rule 4) where it was. */
    const legacyChess = async (ctx: Ctx, status: "decided" | "forfeited") => {
      const fx = await makeFixture(ctx, 2, ctx.entrantA, ctx.entrantB, status);
      if (status === "forfeited") await sql`update fixtures set outcome = ${sql.json({ kind: "double_walkover" })} where id = ${fx}`;
      await sql`
        insert into score_events (fixture_id, org_id, seq, type, payload, recorded_at)
        values (${fx}, ${ctx.orgId}, ${nextSeq(fx)}, 'boardgame.result', ${sql.json({ winner: null, method: "double_forfeit" /* legacy row: a pre-W2b stream */ })},
                now() + interval '1 hour')`;
    };
    const CASES: { name: string; ban: number; write: (ctx: Ctx) => Promise<unknown>; served: number }[] = [
      { name: "a double walkover (by: both)", ban: 5, served: 1, write: async (ctx) => forfeit(ctx, await makeFixture(ctx, 2, ctx.entrantA, ctx.entrantB), "both") },
      { name: "a forfeit by the opponent", ban: 5, served: 0, write: async (ctx) => forfeit(ctx, await makeFixture(ctx, 2, ctx.entrantA, ctx.entrantB), ctx.entrantB) },
      { name: "a forfeit by the suspended entrant", ban: 5, served: 1, write: async (ctx) => forfeit(ctx, await makeFixture(ctx, 2, ctx.entrantB, ctx.entrantA), ctx.entrantA) },
      { name: "the cap: two double walkovers on a ban of 1", ban: 1, served: 1, write: async (ctx) => {
        await forfeit(ctx, await makeFixture(ctx, 2, ctx.entrantA, ctx.entrantB), "both");
        await forfeit(ctx, await makeFixture(ctx, 3, ctx.entrantB, ctx.entrantA), "both");
      } },
      { name: "a legacy chess double forfeit held as decided", ban: 5, served: 1, write: (ctx) => legacyChess(ctx, "decided") },
      { name: "a legacy chess double forfeit refolded to forfeited", ban: 5, served: 1, write: (ctx) => legacyChess(ctx, "forfeited") },
      { name: "a voided double walkover", ban: 5, served: 0, write: async (ctx) => forfeitThenVoid(ctx, await makeFixture(ctx, 2, ctx.entrantA, ctx.entrantB), "both") },
      { name: "a voided forfeit by the suspended entrant", ban: 5, served: 0, write: async (ctx) => forfeitThenVoid(ctx, await makeFixture(ctx, 2, ctx.entrantB, ctx.entrantA), ctx.entrantA) },
    ];
    // Every case read before any is judged, so one red names every case that moved, not just the first.
    const seen: Record<string, [number, string]> = {};
    for (const c of CASES) {
      const { ctx, id } = await banned(c.ban);
      await c.write(ctx);
      const row = (await listSuspensions(ctx.auth, ctx.divisionId)).find((r) => r.id === id)!;
      seen[c.name] = [row.matchesServed, row.status];
    }
    expect(Object.keys(seen).length, "every case ran").toBe(CASES.length);
    expect(seen, `served, status per case: ${JSON.stringify(seen)}`).toEqual(
      Object.fromEntries(CASES.map((c) => [c.name, [c.served, c.served >= c.ban ? "served" : "active"]])),
    );
  }, 180_000);

  // S4 (#428) acceptance: "DisciplineCard.reason is adjudicable: a test
  // expresses a real league rule over it (e.g. 'three cards for the same
  // offence') and that rule fires." Extends DisciplineRules.accumulation with
  // an optional `reason` scope rather than forking the fold — an unscoped
  // rule (every other test in this file) is unaffected, since `reason ===
  // undefined` keeps every card of the colour eligible exactly as before.
  it("(g) an accumulation rule scoped to one offence fires only when THAT offence repeats", async () => {
    const ctx = await seedFootballDivision();
    await setRules(ctx, {
      accumulation: [
        { key: "dissent_x3", color: "yellow", count: 3, ban_matches: 1, reason: "dissent" },
      ],
      dismissal: [],
    });
    const fx = await makeFixture(ctx, 1, ctx.entrantA, ctx.entrantB);

    // Two dissent cards plus one for a DIFFERENT offence: three yellows total,
    // but only two share "dissent" — the scoped rule must not fire yet. If the
    // scope were ignored (colour-only, the pre-#428 shape) this would already
    // be a match at count 3.
    await insertCard(ctx, fx, ctx.entrantA, ctx.personX, "yellow", undefined, "dissent");
    await insertCard(ctx, fx, ctx.entrantA, ctx.personX, "yellow", undefined, "unsporting_behaviour");
    await insertCard(ctx, fx, ctx.entrantA, ctx.personX, "yellow", undefined, "dissent");
    await detect(ctx);
    expect(
      (await listSuspensions(ctx.auth, ctx.divisionId)).filter((r) => r.source === "auto_accumulation"),
    ).toHaveLength(0);

    // A third DISSENT card completes it — the rule fires now.
    await insertCard(ctx, fx, ctx.entrantA, ctx.personX, "yellow", undefined, "dissent");
    await detect(ctx);
    const acc = (await listSuspensions(ctx.auth, ctx.divisionId)).filter(
      (r) => r.source === "auto_accumulation",
    );
    expect(acc).toHaveLength(1);
    expect(acc[0]!.matchesTotal).toBe(1);
    expect(acc[0]!.personId).toBe(ctx.personX);
  });

  it("the scoring decided seam folds discipline without a discipline read", async () => {
    const ctx = await seedFootballDivision();
    await setRules(ctx);
    await sql`update divisions set status = 'active' where id = ${ctx.divisionId}`;
    const cardFx = await makeFixture(ctx, 1, ctx.entrantA, ctx.entrantB);
    for (let i = 0; i < 5; i++) await insertCard(ctx, cardFx, ctx.entrantA, ctx.personX, "yellow");

    // Decide a DIFFERENT fixture by forfeit — the seam re-folds the division.
    const decideFx = await makeFixture(ctx, 2, ctx.entrantA, ctx.entrantB);
    await scoreEvent(ctx.auth, decideFx, {
      expected_seq: 0,
      type: "core.forfeit",
      payload: { by: ctx.entrantB, reason: "walkover" },
    });

    // Read the ledger DIRECTLY (not through a discipline read function) — the
    // pending row must already exist, proving the seam created it.
    const [row] = await sql<{ rule_key: string; status: string }[]>`
      select rule_key, status from suspensions
      where division_id = ${ctx.divisionId} and source = 'auto_accumulation'`;
    expect(row).toEqual({ rule_key: "yellow_5", status: "pending" });
  });

  it("rules editor round-trips and manual bans confirm to active", async () => {
    const ctx = await seedFootballDivision();
    const got0 = await getDisciplineRules(ctx.auth, ctx.divisionId);
    expect(got0).not.toBeNull();
    expect(got0!.enabled).toBe(false);
    expect(got0!.sportColors.map((c) => c.key)).toContain("yellow");

    await putDisciplineRules(ctx.auth, ctx.divisionId, {
      enabled: true,
      rules: RULES,
    });
    const got1 = await getDisciplineRules(ctx.auth, ctx.divisionId);
    expect(got1!.enabled).toBe(true);
    expect(got1!.rules.accumulation).toHaveLength(2);

    const manual = await createManualSuspension(ctx.auth, ctx.divisionId, {
      personId: ctx.personX,
      matchesTotal: 2,
      reason: "violent conduct",
    });
    expect(manual.status).toBe("pending");
    expect(manual.source).toBe("manual");
    const active = await decideSuspension(ctx.auth, manual.id, {
      kind: "confirm",
    });
    expect(active.status).toBe("active");
    expect(active.entrantId).toBe(ctx.entrantA);
  });

  it("RLS tenant isolation: org B reads neither org A's rules nor suspensions", async () => {
    const a = await seedFootballDivision();
    const b = await seedFootballDivision();
    await setRules(a); // discipline_rules row scoped to org A
    await sql`
      insert into suspensions
        (org_id, division_id, person_id, status, source, reason, matches_total, created_by)
      values (${a.orgId}, ${a.divisionId}, ${a.personX}, 'pending', 'manual', 'x', 1, ${a.userId})`;

    // Sanity: the raw superuser connection DOES see org A's rows, so the tenant
    // assertion below is meaningful (not vacuously zero). Point the reads at
    // `sql` instead of `tx` and this test would fail — the harness is honest.
    const [{ count: rawRules }] = await sql<{ count: number }[]>`
      select count(*)::int as count from discipline_rules where division_id = ${a.divisionId}`;
    const [{ count: rawSusp }] = await sql<{ count: number }[]>`
      select count(*)::int as count from suspensions where division_id = ${a.divisionId}`;
    expect({ rawRules, rawSusp }).toEqual({ rawRules: 1, rawSusp: 1 });

    // Through org B's tenant rail, RLS hides both of org A's rows.
    const seen = await withTenant(b.orgId, async (tx) => {
      const [{ rules }] = await tx<{ rules: number }[]>`
        select count(*)::int as rules from discipline_rules where division_id = ${a.divisionId}`;
      const [{ susp }] = await tx<{ susp: number }[]>`
        select count(*)::int as susp from suspensions where division_id = ${a.divisionId}`;
      return { rules, susp };
    });
    expect(seen).toEqual({ rules: 0, susp: 0 });
  });

  it("createManualSuspension rejects a division from another org (404)", async () => {
    const a = await seedFootballDivision();
    const b = await seedFootballDivision();
    // Org A's auth, org B's division id: the division-org guard rejects before
    // any insert, even though personX is a valid org-A person.
    await expect(
      createManualSuspension(a.auth, b.divisionId, {
        personId: a.personX,
        matchesTotal: 1,
        reason: "x",
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("community orgs are gated on every authed entry point (PlusReveal 402)", async () => {
    const ctx = await seedFootballDivision("community");
    // GET rules signals the paywall (the sport HAS a card model, so it is not
    // the null "no discipline" case) — the console renders PlusReveal from it.
    await expect(getDisciplineRules(ctx.auth, ctx.divisionId)).rejects.toBeInstanceOf(
      PaymentRequiredError,
    );
    await expect(
      putDisciplineRules(ctx.auth, ctx.divisionId, {
        enabled: true,
        rules: RULES,
      }),
    ).rejects.toBeInstanceOf(PaymentRequiredError);
    await expect(listSuspensions(ctx.auth, ctx.divisionId)).rejects.toBeInstanceOf(
      PaymentRequiredError,
    );
    await expect(
      createManualSuspension(ctx.auth, ctx.divisionId, {
        personId: ctx.personX,
        matchesTotal: 1,
        reason: "x",
      }),
    ).rejects.toBeInstanceOf(PaymentRequiredError);
  });

  // Phase 3 wave 4 (T3, kind `suspension_confirmed`): confirming a ban queues the player's notice on the email outbox
  // in the decision's own transaction (R1), only on the pending -> active transition (R6: a re-confirm of a live ban,
  // a waive or an adjust queues nothing), backed by the once-key `<id>:confirmed`; the request makes the first attempt
  // after commit (R5). An unclaimed player has no account to address and gets no row.
  // Not built (owner rule 2026-10-26, mainstream only): a rollback witnessed by a failing statement after the enqueue
  // (`plantFailingUpdate` does not exist); the row shares the decision's transaction by construction.
  // Sport: not applicable (the notice does not vary by sport; football is the seed every discipline test uses).
  describe("the confirmed notice goes through the email outbox (suspension_confirmed)", () => {
    const manualBan = (ctx: Ctx, personId: string, matchesTotal = 2) =>
      createManualSuspension(ctx.auth, ctx.divisionId, { personId, matchesTotal, reason: "violent conduct" });

    it("confirming queues one notice to the claimed player, in their language, from the request", async () => {
      const ctx = await seedFootballDivision();
      const email = address("confirmed");
      const userId = await claimPerson(ctx.personX, email);
      await sql`update users set locale = 'es' where id = ${userId}`;
      const ban = await manualBan(ctx, ctx.personX);

      const active = await decideSuspension(ctx.auth, ban.id, { kind: "confirm" });
      expect(active.status).toBe("active");

      const rows = await settledNoticesOf("suspension_confirmed", ban.id);
      expect(rows, "one notice for the one confirmation").toHaveLength(1);
      const subject = dictionarySubject("es", "suspensionConfirmed.subject", { division: "Open" });
      expect(subject, "premise: the Spanish subject is not the English one").not.toBe(
        dictionarySubject("en", "suspensionConfirmed.subject", { division: "Open" }),
      );
      expect(rows[0]).toMatchObject({
        ref_type: "suspension",
        ref_id: ban.id,
        dedupe_key: `${ban.id}:confirmed`,
        org_id: ctx.orgId,
        recipient: email,
        recipient_user_id: userId,
        transactional: true,
        subject,
        // R5: the request made the first attempt after commit (the worker never runs here).
        status: "sent",
      });
      expect(Math.abs(rows[0]!.expires_at.getTime() - rows[0]!.created_at.getTime() - MAX_EXPIRY_MS), "the bound").toBeLessThan(1_000);
      expect(sendsOf(rows[0]!.id), "sent once").toBe(1);
      expect(await noticesOf("suspension_served", ban.id), "no served notice for a ban nothing has served").toEqual([]);
    });

    it("confirming twice queues one", async () => {
      const ctx = await seedFootballDivision();
      await claimPerson(ctx.personX, address("twice"));
      const ban = await manualBan(ctx, ctx.personX);

      await decideSuspension(ctx.auth, ban.id, { kind: "confirm" });
      await settledNoticesOf("suspension_confirmed", ban.id);
      const again = await decideSuspension(ctx.auth, ban.id, { kind: "confirm" });
      expect(again.status, "premise: the second confirm went through").toBe("active");

      expect(await settledNoticesOf("suspension_confirmed", ban.id), "one row").toHaveLength(1);
      // R6: the second confirm found the ban already active and did not ask; the once-key alone would hide a second ask.
      expect(asksFor("suspension_confirmed", ban.id), "asked once").toBe(1);
    });

    it("empty: an unclaimed player's ban is confirmed with no row", async () => {
      const ctx = await seedFootballDivision();
      // personY has no account: nothing to address.
      const ban = await manualBan(ctx, ctx.personY);

      const active = await decideSuspension(ctx.auth, ban.id, { kind: "confirm" });

      expect(active.status, "the confirmation itself went through").toBe("active");
      expect(await noticesOf("suspension_confirmed", ban.id)).toEqual([]);
    });

    it("D4: no account language → the org's default", async () => {
      const ctx = await seedFootballDivision();
      await sql`update organizations set default_locale = 'fr' where id = ${ctx.orgId}`;
      const userId = await claimPerson(ctx.personX, address("d4"));
      const [premise] = await sql<{ locale: string | null }[]>`select locale from users where id = ${userId}`;
      expect(premise!.locale, "premise: the account has no language").toBeNull();
      const ban = await manualBan(ctx, ctx.personX);

      await decideSuspension(ctx.auth, ban.id, { kind: "confirm" });

      const subject = dictionarySubject("fr", "suspensionConfirmed.subject", { division: "Open" });
      expect(subject, "premise: the French subject is not the English one").not.toBe(
        dictionarySubject("en", "suspensionConfirmed.subject", { division: "Open" }),
      );
      expect((await settledNoticesOf("suspension_confirmed", ban.id)).map((r) => r.subject)).toEqual([subject]);
    });

    it("waive and adjust queue nothing", async () => {
      const ctx = await seedFootballDivision();
      await claimPerson(ctx.personX, address("decide"));
      // A pending ban adjusted, then waived: never confirmed, never mailed.
      const waived = await manualBan(ctx, ctx.personX);
      await decideSuspension(ctx.auth, waived.id, { kind: "adjust", matchesTotal: 3, reason: "serious foul play" });
      expect((await decideSuspension(ctx.auth, waived.id, { kind: "waive" })).status, "premise: waived").toBe("waived");
      expect(await noticesOf("suspension_confirmed", waived.id)).toEqual([]);
      expect(asksFor("suspension_confirmed", waived.id)).toBe(0);
      // A confirmed ban adjusted afterwards: the one notice of its confirmation, nothing more.
      const live = await manualBan(ctx, ctx.personX);
      await decideSuspension(ctx.auth, live.id, { kind: "confirm" });
      await decideSuspension(ctx.auth, live.id, { kind: "adjust", matchesTotal: 4 });
      expect(await settledNoticesOf("suspension_confirmed", live.id)).toHaveLength(1);
      expect(asksFor("suspension_confirmed", live.id), "the adjust did not ask").toBe(1);
    });

    it("the confirmed helper called twice for one ban writes one row", async () => {
      const ctx = await seedFootballDivision();
      await claimPerson(ctx.personX, address("helper"));
      const ban = await manualBan(ctx, ctx.personX);

      const [first, second] = await withTenant(ctx.orgId, async (tx) => [
        await queueSuspensionConfirmed(tx, ban.id),
        await queueSuspensionConfirmed(tx, ban.id),
      ]);

      expect(first, "the first call queued a row").toEqual(expect.any(String));
      expect(second, "the second found the once-key taken").toBeNull();
      expect((await noticesOf("suspension_confirmed", ban.id)).map((r) => r.id)).toEqual([first]);
    });
  });

  // Phase 3 wave 4 (T3, kind `suspension_served`): the flip active -> served queues the player's notice on the email
  // outbox IN the transaction that flips the ban (R1, every serving pass: write paths and read paths alike), once per
  // ban (once-key `<id>:served`), and leaves the first attempt to the retry worker (W: a read path has no request to
  // send it from). A pass that rolls back takes its row with it, so the notice exists exactly when the flip committed:
  // that is what the old after-commit `xmin` check stood in for (spec §8).
  it("the active→served flip queues one served notice, left to the worker", async () => {
    const ctx = await seedFootballDivision();
    const email = address("served");
    const userId = await claimPerson(ctx.personX, email);
    const manual = await createManualSuspension(ctx.auth, ctx.divisionId, {
      personId: ctx.personX,
      matchesTotal: 1,
      reason: "violent conduct",
    });
    const active = await decideSuspension(ctx.auth, manual.id, {
      kind: "confirm",
    });
    expect(active.entrantId).toBe(ctx.entrantA);
    expect(await noticesOf("suspension_served", manual.id), "premise: nothing served yet").toEqual([]);

    // A decided fixture for the banned entrant, stamped after the ban's decided_at,
    // serves the one-match ban. The recompute-on-read flips active→served.
    const fx = await makeFixture(ctx, 2, ctx.entrantA, ctx.entrantB, "decided");
    await sql`
      insert into score_events (fixture_id, org_id, seq, type, payload, recorded_at)
      values (${fx}, ${ctx.orgId}, ${nextSeq(fx)}, 'core.note', ${sql.json({ text: "d" })},
              now() + interval '1 hour')`;

    const served = (await listSuspensions(ctx.auth, ctx.divisionId)).find(
      (r) => r.id === manual.id,
    )!;
    expect(served.status).toBe("served");
    const rows = await noticesOf("suspension_served", manual.id);
    expect(rows, "one notice on the flip").toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ref_type: "suspension",
      ref_id: manual.id,
      dedupe_key: `${manual.id}:served`,
      org_id: ctx.orgId,
      recipient: email,
      recipient_user_id: userId,
      transactional: true,
      // No account language, no org default: `en`.
      subject: dictionarySubject("en", "suspensionServed.subject", { division: "Open" }),
      // W: queued for the worker, never attempted by the read that flipped it.
      status: "queued",
      attempts: 0,
    });
    expect(Math.abs(rows[0]!.expires_at.getTime() - rows[0]!.created_at.getTime() - MAX_EXPIRY_MS), "the bound").toBeLessThan(1_000);
    await new Promise((r) => setTimeout(r, 300));
    expect(sendsOf(rows[0]!.id), "no transport call: the worker sends it").toBe(0);
    // A second read finds nothing active: no second row, and it did not even ask.
    await listSuspensions(ctx.auth, ctx.divisionId);
    expect((await noticesOf("suspension_served", manual.id)).map((r) => r.id)).toEqual([rows[0]!.id]);
    expect(asksFor("suspension_served", manual.id)).toBe(1);
  });

  it("the served helper called twice for one ban writes one row", async () => {
    const ctx = await seedFootballDivision();
    await claimPerson(ctx.personX, address("served-helper"));
    const ban = await createManualSuspension(ctx.auth, ctx.divisionId, { personId: ctx.personX, matchesTotal: 1, reason: "dissent" });

    const [first, second] = await withTenant(ctx.orgId, async (tx) => [
      await queueSuspensionServed(tx, ban.id),
      await queueSuspensionServed(tx, ban.id),
    ]);

    expect(first, "the first call queued a row").toEqual(expect.any(String));
    expect(second, "the second found the once-key taken").toBeNull();
    expect((await noticesOf("suspension_served", ban.id)).map((r) => r.id)).toEqual([first]);
  });

  // The division page used to be what served a manual ban in a division whose
  // auto-discipline is OFF: `refreshDiscipline` returned before folding unless a
  // rules row was enabled, so the only thing that ever advanced the counter was
  // a public read. The competition hub reads bans without writing, so the WRITE
  // path has to serve them itself. Read the row directly: every discipline
  // reader serves on read and would hide a write path that does not.
  it("discipline OFF: the score that serves a manual ban flips it on the write path, with one served notice", async () => {
    const ctx = await seedFootballDivision();
    await sql`update divisions set status = 'active' where id = ${ctx.divisionId}`;
    const [rulesRow] = await sql`select 1 from discipline_rules where division_id = ${ctx.divisionId}`;
    expect(rulesRow).toBeUndefined();
    const email = `claim-${randomUUID().slice(0, 8)}@test.local`;
    await claimPerson(ctx.personX, email);
    const manual = await createManualSuspension(ctx.auth, ctx.divisionId, {
      personId: ctx.personX,
      matchesTotal: 1,
      reason: "violent conduct",
    });
    await decideSuspension(ctx.auth, manual.id, { kind: "confirm" });

    // Team A forfeits a fixture after the ban was decided: that serves A's one match.
    const fx = await makeFixture(ctx, 2, ctx.entrantA, ctx.entrantB);
    await scoreEvent(ctx.auth, fx, {
      expected_seq: 0,
      type: "core.forfeit",
      payload: { by: ctx.entrantA, reason: "walkover" },
    });

    const [row] = await sql<{ status: string; matches_served: number }[]>`
      select status, matches_served from suspensions where id = ${manual.id}`;
    expect(row).toEqual({ status: "served", matches_served: 1 });
    const rows = await noticesOf("suspension_served", manual.id);
    expect(rows.map((r) => [r.recipient, r.status, r.attempts]), "one notice, queued for the worker").toEqual([[email, "queued", 0]]);
    // Running the write-path fold again finds nothing active: no second row.
    await refreshDiscipline(ctx.auth, fx);
    expect((await noticesOf("suspension_served", manual.id)).map((r) => r.id)).toEqual([rows[0]!.id]);
  });

  // Two serving passes can read ONE active ban at the same time: a decided
  // score write (`refreshDiscipline`) against a division page read
  // (`publicSuspensions` still serves on read), or two decided writes in one
  // division (two courts finishing together). Each computes "served"; only one
  // may flip the row, and only the flip that COMMITTED may leave a notice.
  describe("serving under concurrency — one flip, one served notice, queued with the flip", () => {
    /** The holder's grip on the ban row: its transaction id and the row's
     *  physical address, which is all a waiter on THAT row can be waiting on. */
    interface Grip {
      xid: string;
      page: number;
      tuple: number;
    }

    /** Poll `pg_locks` for genuinely blocked waiters — the technique of
     *  `registration-concurrency.test.ts` — but only waiters on the HOLDER's
     *  row: the first queues on the holder's transaction id, every later one on
     *  that row's tuple lock. A cluster-wide count would let blocked locks from
     *  any other suite on a shared database release the racers early, and a
     *  race run one after the other still passes. */
    async function waitForRacersBlocked(grip: Grip, count: number, timeoutMs = 10_000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const [row] = await sql<{ n: number }[]>`
          select count(*)::int as n from pg_locks l
          where not l.granted
            and ((l.locktype = 'transactionid' and l.transactionid::text = ${grip.xid})
              or (l.locktype = 'tuple' and l.relation = 'suspensions'::regclass
                  and l.page = ${grip.page} and l.tuple = ${grip.tuple}))`;
        if (row!.n >= count) return;
        if (Date.now() > deadline) throw new Error(`only ${row!.n}/${count} blocked racers appeared — race not staged`);
        await new Promise((r) => setTimeout(r, 25));
      }
    }

    it("the race release counts ONLY waiters on the held ban row — blocked locks elsewhere on the database never release it", async () => {
      const { personX: personId } = await seedFootballDivision();
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let staged!: () => void;
      const isStaged = new Promise<void>((resolve) => (staged = resolve));
      // Two waiters blocked on an UNRELATED row (a person), from this very suite.
      const holder = sql.begin(async (tx) => {
        await tx`select 1 from persons where id = ${personId} for update`;
        staged();
        await held;
      });
      holder.catch(() => {});
      await isStaged;
      const bystanders = Promise.all([
        sql`update persons set full_name = full_name where id = ${personId}`,
        sql`update persons set full_name = full_name where id = ${personId}`,
      ]);
      bystanders.catch(() => {});
      try {
        // Not vacuous: wait until the database really has both bystanders blocked…
        for (let i = 0; ; i++) {
          const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from pg_locks where not granted`;
          if (n >= 2) break;
          if (i > 400) throw new Error("the bystanders never blocked");
          await new Promise((r) => setTimeout(r, 25));
        }
        // …and a grip on a transaction and a row nobody is waiting on is not staged.
        await expect(waitForRacersBlocked({ xid: "0", page: 0, tuple: 0 }, 2, 400)).rejects.toThrow("race not staged");
      } finally {
        release();
        await holder;
        await bystanders;
      }
    });

    /** A claimed player's one-match ban, confirmed, with two decided fixtures
     *  of their team stamped after it — either one serves it. */
    async function dueBan() {
      const ctx = await seedFootballDivision();
      await claimPerson(ctx.personX, `claim-${randomUUID().slice(0, 8)}@test.local`);
      const manual = await createManualSuspension(ctx.auth, ctx.divisionId, {
        personId: ctx.personX,
        matchesTotal: 1,
        reason: "violent conduct",
      });
      await decideSuspension(ctx.auth, manual.id, { kind: "confirm" });
      const fixtures: string[] = [];
      for (const seq of [2, 3]) {
        const fx = await makeFixture(ctx, seq, ctx.entrantA, ctx.entrantB, "decided");
        await sql`
          insert into score_events (fixture_id, org_id, seq, type, payload, recorded_at)
          values (${fx}, ${ctx.orgId}, ${nextSeq(fx)}, 'core.note', ${sql.json({ text: "d" })},
                  now() + interval '1 hour')`;
        fixtures.push(fx);
      }
      const [org] = await sql<{ slug: string }[]>`select slug from organizations where id = ${ctx.orgId}`;
      const [comp] = await sql<{ slug: string }[]>`select slug from competitions where org_id = ${ctx.orgId}`;
      const [division] = await sql<{ slug: string }[]>`select slug from divisions where id = ${ctx.divisionId}`;
      return { ctx, banId: manual.id, fixtures, slugs: [org!.slug, comp!.slug, division!.slug] as const };
    }

    const statusOf = async (banId: string) =>
      (await sql<{ status: string; matches_served: number }[]>`
        select status, matches_served from suspensions where id = ${banId}`)[0];

    /** Park every racer on the ban's row lock — so each has already READ the
     *  ban as active and computed "served" — then release them together. */
    async function race<T = unknown>(banId: string, racers: () => Promise<T>[]): Promise<T[]> {
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let staged!: () => void;
      const isStaged = new Promise<void>((resolve) => (staged = resolve));
      let grip!: Grip;
      const holder = sql.begin(async (tx) => {
        const [row] = await tx<{ ctid: string; xid: string }[]>`
          select ctid::text as ctid, pg_current_xact_id()::text as xid
          from suspensions where id = ${banId} for update`;
        const [page, tuple] = row!.ctid.replace(/[()]/g, "").split(",").map(Number);
        grip = { xid: row!.xid, page: page!, tuple: tuple! };
        staged();
        await held;
      });
      holder.catch(() => {});
      await isStaged;
      const racing = Promise.all(racers());
      racing.catch(() => {});
      try {
        await waitForRacersBlocked(grip, 2);
      } finally {
        // Released even when staging fails, so a broken stage reds this test
        // instead of parking the racers on the holder forever.
        release();
        await holder;
      }
      return racing;
    }

    it("a decided score write and a division page read, together: one flip, ONE served notice", async () => {
      const { ctx, banId, fixtures, slugs } = await dueBan();
      await race<unknown>(banId, () => [refreshDiscipline(ctx.auth, fixtures[0]!), publicSuspensions(...slugs)]);
      expect(await statusOf(banId)).toEqual({ status: "served", matches_served: 1 });
      expect(await noticesOf("suspension_served", banId), "one row").toHaveLength(1);
      // Only the pass whose guarded update flipped the ban asked; the once-key alone would hide a second ask.
      expect(asksFor("suspension_served", banId), "asked once").toBe(1);
    });

    it("two decided score writes in one division, together: one flip, ONE served notice", async () => {
      const { ctx, banId, fixtures } = await dueBan();
      await race(banId, () => [refreshDiscipline(ctx.auth, fixtures[0]!), refreshDiscipline(ctx.auth, fixtures[1]!)]);
      expect(await statusOf(banId)).toEqual({ status: "served", matches_served: 1 });
      expect(await noticesOf("suspension_served", banId), "one row").toHaveLength(1);
      expect(asksFor("suspension_served", banId), "asked once").toBe(1);
    });

    it("exactly ONE of two racing passes reports the flip — the other's guarded update matched nothing", async () => {
      const { ctx, banId } = await dueBan();
      const flips = await race(banId, () => [
        withTenant(ctx.orgId, (tx) => detectSuspensions(tx, ctx.divisionId)),
        withTenant(ctx.orgId, (tx) => detectSuspensions(tx, ctx.divisionId)),
      ]);
      expect(flips.flat()).toEqual([banId]);
      // The pass that flipped it queued the one notice; nothing was sent (the worker sends it).
      const rows = await noticesOf("suspension_served", banId);
      expect(rows.map((r) => [r.status, r.attempts])).toEqual([["queued", 0]]);
      expect(sendsOf(rows[0]!.id)).toBe(0);
    });

    it("a serving pass whose transaction ROLLS BACK leaves no notice; the next committed pass flips it and queues the one", async () => {
      const { ctx, banId } = await dueBan();
      await expect(
        withTenant(ctx.orgId, async (tx) => {
          await detectSuspensions(tx, ctx.divisionId);
          throw new Error("rolled back after serving");
        }),
      ).rejects.toThrow("rolled back after serving");
      expect(await statusOf(banId)).toEqual({ status: "active", matches_served: 0 });
      expect(asksFor("suspension_served", banId), "premise: the rolled-back pass did flip it and ask").toBe(1);
      expect(await noticesOf("suspension_served", banId), "its row rolled back with it").toEqual([]);

      await listSuspensions(ctx.auth, ctx.divisionId);
      expect(await statusOf(banId)).toEqual({ status: "served", matches_served: 1 });
      expect(await noticesOf("suspension_served", banId), "the committed pass's one row").toHaveLength(1);
    });

    // `activeSuspensionsByEntrant` serves inside a transaction its CALLER owns
    // (the organiser division page): the notice is queued in that same
    // transaction, so it stands or falls with the caller's commit.
    it("the entrant-chip read serves inside its caller's transaction: no notice if that rolls back, one once it commits", async () => {
      const { ctx, banId } = await dueBan();
      await expect(
        withTenant(ctx.orgId, async (tx) => {
          await activeSuspensionsByEntrant(tx, ctx.divisionId);
          throw new Error("caller rolled back");
        }),
      ).rejects.toThrow("caller rolled back");
      expect(await statusOf(banId)).toEqual({ status: "active", matches_served: 0 });
      expect(await noticesOf("suspension_served", banId)).toEqual([]);

      await withTenant(ctx.orgId, (tx) => activeSuspensionsByEntrant(tx, ctx.divisionId));
      expect(await statusOf(banId)).toEqual({ status: "served", matches_served: 1 });
      expect((await noticesOf("suspension_served", banId)).map((r) => [r.status, r.attempts])).toEqual([["queued", 0]]);
    });
  });

  // The served notice no longer runs after the write: it is a row the write's own transaction queued, and the retry
  // worker sends it. So nothing after the commit can fail the score, and the notice still reaches the player.
  describe("the served notice is the worker's: queued with the flip, sent by the worker", () => {
    async function forfeitServesBan() {
      const ctx = await seedFootballDivision();
      await sql`update divisions set status = 'active' where id = ${ctx.divisionId}`;
      const email = address("worker");
      await claimPerson(ctx.personX, email);
      const manual = await createManualSuspension(ctx.auth, ctx.divisionId, {
        personId: ctx.personX,
        matchesTotal: 1,
        reason: "violent conduct",
      });
      await decideSuspension(ctx.auth, manual.id, { kind: "confirm" });
      const fx = await makeFixture(ctx, 2, ctx.entrantA, ctx.entrantB);
      return { ctx, banId: manual.id, fx, email };
    }

    it("the score that serves the ban resolves, the result and the flip both stand, the notice waits queued, and one worker tick sends it", async () => {
      const { ctx, banId, fx, email } = await forfeitServesBan();

      await expect(
        scoreEvent(ctx.auth, fx, { expected_seq: 0, type: "core.forfeit", payload: { by: ctx.entrantA, reason: "walkover" } }),
      ).resolves.toBeDefined();

      const [fixture] = await sql<{ status: string }[]>`select status from fixtures where id = ${fx}`;
      expect(fixture!.status).toBe("forfeited");
      const [ban] = await sql<{ status: string }[]>`select status from suspensions where id = ${banId}`;
      expect(ban!.status).toBe("served");
      const [row] = await noticesOf("suspension_served", banId);
      expect(row, "the notice was queued with the flip").toMatchObject({ status: "queued", attempts: 0, recipient: email });
      expect(sendsOf(row!.id), "the score's request did not send it").toBe(0);

      // The worker's turn: past the first-attempt window, one tick sends it.
      await bornAgo([row!.id]);
      await runOutboxTick({ onlyIds: [row!.id], sleep: async () => undefined });
      expect((await noticesOf("suspension_served", banId)).map((r) => r.status)).toEqual(["sent"]);
      expect(sendsOf(row!.id), "sent once, by the worker").toBe(1);
    });
  });

  it("waive: excluded from activeSuspensionsByEntrant/publicSuspensions, and a real serving pass that serves its un-waived twin leaves it unserved", async () => {
    const ctx = await seedFootballDivision();
    await claimPerson(ctx.personX, `claim-${randomUUID().slice(0, 8)}@test.local`);
    await claimPerson(ctx.personY, `claim-${randomUUID().slice(0, 8)}@test.local`);
    // Two one-match bans, both live: X's (entrant A) is about to be waived, Y's (entrant B) is the positive pair.
    const toWaive = await createManualSuspension(ctx.auth, ctx.divisionId, { personId: ctx.personX, matchesTotal: 1, reason: "dissent" });
    const twin = await createManualSuspension(ctx.auth, ctx.divisionId, { personId: ctx.personY, matchesTotal: 1, reason: "dissent" });
    for (const ban of [toWaive, twin]) {
      expect((await decideSuspension(ctx.auth, ban.id, { kind: "confirm" })).status, "premise: live").toBe("active");
    }

    const waived = await decideSuspension(ctx.auth, toWaive.id, { kind: "waive" });
    expect(waived.status).toBe("waived");

    const byEntrant = await withTenant(ctx.orgId, (tx) => activeSuspensionsByEntrant(tx, ctx.divisionId));
    expect(byEntrant.get(ctx.entrantA) ?? [], "the waived ban is off its entrant's chip").toHaveLength(0);
    expect(byEntrant.get(ctx.entrantB) ?? [], "positive pair: the live twin is on its entrant's chip").toHaveLength(1);

    const [org] = await sql<{ slug: string }[]>`select slug from organizations where id = ${ctx.orgId}`;
    const [comp] = await sql<{ slug: string }[]>`select slug from competitions where org_id = ${ctx.orgId}`;
    const [division] = await sql<{ slug: string }[]>`select slug from divisions where id = ${ctx.divisionId}`;
    const pub = await publicSuspensions(org!.slug, comp!.slug, division!.slug);
    expect(pub, "only the live twin is listed publicly; the waived ban is not").toHaveLength(1);

    // A decided A-vs-B fixture stamped after both decisions: it would serve BOTH one-match bans had X's not been waived.
    const fx = await makeFixture(ctx, 2, ctx.entrantA, ctx.entrantB, "decided");
    await sql`
      insert into score_events (fixture_id, org_id, seq, type, payload, recorded_at)
      values (${fx}, ${ctx.orgId}, ${nextSeq(fx)}, 'core.note', ${sql.json({ text: "d" })}, now() + interval '1 hour')`;

    // The real serving pass (the recompute-on-read of the division's list).
    const rows = await listSuspensions(ctx.auth, ctx.divisionId);
    expect(rows.find((r) => r.id === twin.id)?.status, "positive pair: the pass served the live twin").toBe("served");
    expect(await noticesOf("suspension_served", twin.id), "and queued its served notice").toHaveLength(1);
    expect(await noticesOf("suspension_served", toWaive.id), "the same pass queued no served notice for the waived ban").toEqual([]);
    expect(rows.find((r) => r.id === toWaive.id)?.status, "and left it waived").toBe("waived");
  });

  it("a yellow-accumulation threshold and a straight red fire together without cross-contamination", async () => {
    const ctx = await seedFootballDivision();
    await setRules(ctx);
    const fx = await makeFixture(ctx, 1, ctx.entrantA, ctx.entrantB);
    // Same person, same window: 5 yellows AND a straight red.
    for (let i = 0; i < 5; i++) await insertCard(ctx, fx, ctx.entrantA, ctx.personX, "yellow");
    await insertCard(ctx, fx, ctx.entrantA, ctx.personX, "red");

    await detect(ctx);
    const rows = await listSuspensions(ctx.auth, ctx.divisionId);
    expect(rows).toHaveLength(2);
    const acc = rows.find((r) => r.source === "auto_accumulation")!;
    const dis = rows.find((r) => r.source === "auto_dismissal")!;
    expect(acc).toBeDefined();
    expect(dis).toBeDefined();
    expect(acc.personId).toBe(ctx.personX);
    expect(dis.personId).toBe(ctx.personX);
    const meta = await sql<{ rule_key: string; source: string; bucket: number }[]>`
      select rule_key, source, bucket from suspensions where division_id = ${ctx.divisionId}
      order by source`;
    expect(meta).toEqual([
      { rule_key: "yellow_5", source: "auto_accumulation", bucket: 1 },
      { rule_key: "red", source: "auto_dismissal", bucket: 1 },
    ]);
  });

  it("multi-match serving: a 2-match ban is served across two decided fixtures", async () => {
    const ctx = await seedFootballDivision();
    const manual = await createManualSuspension(ctx.auth, ctx.divisionId, {
      personId: ctx.personX,
      matchesTotal: 2,
      reason: "violent conduct",
    });
    const active = await decideSuspension(ctx.auth, manual.id, {
      kind: "confirm",
    });
    expect(active.entrantId).toBe(ctx.entrantA);
    expect(active.status).toBe("active");

    const stampDecided = async (round: number) => {
      const fx = await makeFixture(ctx, round, ctx.entrantA, ctx.entrantB, "decided");
      await sql`
        insert into score_events (fixture_id, org_id, seq, type, payload, recorded_at)
        values (${fx}, ${ctx.orgId}, ${nextSeq(fx)}, 'core.note', ${sql.json({ text: "d" })},
                now() + interval '1 hour')`;
    };
    await stampDecided(2);
    const partial = (await listSuspensions(ctx.auth, ctx.divisionId)).find(
      (r) => r.id === manual.id,
    )!;
    expect(partial.matchesServed).toBe(1);
    expect(partial.status).toBe("active");

    await stampDecided(3);
    const served = (await listSuspensions(ctx.auth, ctx.divisionId)).find(
      (r) => r.id === manual.id,
    )!;
    expect(served.matchesServed).toBe(2);
    expect(served.status).toBe("served");
  });

  it("publicSuspensions masks a person without public_name consent (never omits)", async () => {
    const ctx = await seedFootballDivision();
    // personX carries the default consent '{}' from seedFootballDivision — no
    // public_name grant, so public_person_name masks to initials.
    const manual = await createManualSuspension(ctx.auth, ctx.divisionId, {
      personId: ctx.personX,
      matchesTotal: 1,
      reason: "x",
    });
    await decideSuspension(ctx.auth, manual.id, { kind: "confirm" });

    const [org] = await sql<
      { slug: string }[]
    >`select slug from organizations where id = ${ctx.orgId}`;
    const [comp] = await sql<
      { slug: string }[]
    >`select slug from competitions where org_id = ${ctx.orgId}`;
    const [division] = await sql<
      { slug: string }[]
    >`select slug from divisions where id = ${ctx.divisionId}`;
    const pub = await publicSuspensions(org!.slug, comp!.slug, division!.slug);
    expect(pub).toHaveLength(1); // masked, not omitted
    expect(pub[0]!.name).not.toContain("Xavier");
    expect(pub[0]!.name).not.toContain("Smith");
    expect(pub[0]!.name).toBe("X.S."); // "Xavier Smith" initials, per public_person_name
  });

  // Division-page parity for the competition hub (owner ruling 2026-09-16):
  // the hub tags the suspended MEMBER on its Teams card and lists the ban under
  // its division on Info, so it needs WHO — a person and an entrant — not a
  // masked string it would have to match against a roster by name. And it
  // reads without writing: a hub rebuild has no single-flight.
  describe("activePublicSuspensionEntries — who is suspended, for the hub, read-only", () => {
    async function slugsOf(ctx: Ctx) {
      const [org] = await sql<{ slug: string }[]>`select slug from organizations where id = ${ctx.orgId}`;
      const [comp] = await sql<{ slug: string }[]>`select slug from competitions where org_id = ${ctx.orgId}`;
      const [division] = await sql<{ slug: string }[]>`select slug from divisions where id = ${ctx.divisionId}`;
      return [org!.slug, comp!.slug, division!.slug] as const;
    }
    async function ban(ctx: Ctx, personId: string, matchesTotal: number): Promise<string> {
      const manual = await createManualSuspension(ctx.auth, ctx.divisionId, {
        personId,
        matchesTotal,
        reason: "violent conduct",
      });
      await decideSuspension(ctx.auth, manual.id, { kind: "confirm" });
      return manual.id;
    }
    it("carries the person and the entrant, so two people with ONE name on two teams are told apart", async () => {
      const ctx = await seedFootballDivision();
      // A second "Xavier Smith" — a different person, on the OTHER team. Any
      // join by name marks both; only the ids can mark one.
      const [{ id: twin }] = await sql<{ id: string }[]>`
        insert into persons (org_id, full_name) values (${ctx.orgId}, 'Xavier Smith') returning id`;
      await sql`insert into entrant_members (entrant_id, person_id, org_id) values (${ctx.entrantB}, ${twin}, ${ctx.orgId})`;
      await ban(ctx, ctx.personX, 2);

      const entries = await activePublicSuspensionEntries([ctx.divisionId]);
      expect(entries).toEqual([
        { divisionId: ctx.divisionId, personId: ctx.personX, entrantId: ctx.entrantA, name: "X.S.", remaining: 2 },
      ]);
      expect(entries[0]!.personId).not.toBe(twin);
    });

    // The hub reader's naming rule for a ban: `public_person_name` (consent — a
    // never-answered consent reads as initials) with the division's youth/name
    // policy applied ON TOP through the RS008 resolver (so a consented youth is
    // masked too), read from the division's own columns. The strip on THIS
    // branch is `public_person_name` alone; the youth half reaches it with the
    // privacy hotfix, which applies the same resolver on top. Only the adult
    // cases are asserted equal to the strip (the parity test below).
    it("the hub reader names a ban by public_person_name, then the division's youth/name policy: never-answered consent → initials, consented adult → full name, consented youth → masked, opt-out → initials", async () => {
      const adult = await seedFootballDivision();
      const youth = await seedFootballDivision();
      await sql`update divisions set youth = true where id = ${youth.divisionId}`;
      await ban(adult, adult.personX, 1);
      await ban(youth, youth.personX, 3);
      const both = [adult.divisionId, youth.divisionId];
      const nameIn = async (divisionId: string) =>
        (await activePublicSuspensionEntries(both)).find((e) => e.divisionId === divisionId)!.name;

      // Never answered, both divisions: initials — the strip's SQL name.
      expect(await nameIn(adult.divisionId)).toBe("X.S.");
      expect(await nameIn(youth.divisionId)).toBe("X.S.");

      await sql`update persons set consent = ${sql.json({ public_name: true })} where id in ${sql([adult.personX, youth.personX])}`;
      // Consented adult: the full name. Consented youth: the division masks it.
      expect(await nameIn(adult.divisionId)).toBe("Xavier Smith");
      expect(await nameIn(youth.divisionId)).toBe("Xavier S.");

      await sql`update persons set consent = ${sql.json({ public_name: false })} where id = ${adult.personX}`;
      expect(await nameIn(adult.divisionId)).toBe("X.S.");

      // A division nobody asked about is not read, and no ids is no query.
      expect((await activePublicSuspensionEntries([adult.divisionId])).map((e) => e.divisionId)).toEqual([
        adult.divisionId,
      ]);
      expect(await activePublicSuspensionEntries([])).toEqual([]);
    });

    it("an adult ban reads the same on the hub as on the division strip, for every consent answer", async () => {
      const ctx = await seedFootballDivision();
      await ban(ctx, ctx.personX, 2);
      const [orgSlug, compSlug, divSlug] = await slugsOf(ctx);
      for (const consent of [{}, { public_name: true }, { public_name: false }]) {
        await sql`update persons set consent = ${sql.json(consent)} where id = ${ctx.personX}`;
        const hub = (await activePublicSuspensionEntries([ctx.divisionId])).map((e) => e.name);
        const strip = (await publicSuspensions(orgSlug, compSlug, divSlug)).map((e) => e.name);
        expect({ consent, hub }).toEqual({ consent, hub: strip });
      }
    });

    it("a competition a spectator cannot see answers nothing, whatever id is passed", async () => {
      const ctx = await seedFootballDivision();
      await ban(ctx, ctx.personX, 1);
      await sql`update competitions set visibility = 'private' where org_id = ${ctx.orgId}`;
      expect(await activePublicSuspensionEntries([ctx.divisionId])).toEqual([]);
    });

    it("READ-ONLY: a ban a result has already served stays active in the table, is still listed, and no served notice is queued — the division page's reader still serves it", async () => {
      const ctx = await seedFootballDivision();
      await claimPerson(ctx.personX, `claim-${randomUUID().slice(0, 8)}@test.local`);
      const id = await ban(ctx, ctx.personX, 1);
      // A decided fixture for A, stamped after the ban — written straight to
      // the table, so no write path has served the ban yet.
      const fx = await makeFixture(ctx, 2, ctx.entrantA, ctx.entrantB, "decided");
      await sql`
        insert into score_events (fixture_id, org_id, seq, type, payload, recorded_at)
        values (${fx}, ${ctx.orgId}, ${nextSeq(fx)}, 'core.note', ${sql.json({ text: "d" })},
                now() + interval '1 hour')`;
      const statusOf = async () =>
        (await sql<{ status: string; matches_served: number }[]>`
          select status, matches_served from suspensions where id = ${id}`)[0];

      const entries = await activePublicSuspensionEntries([ctx.divisionId]);
      expect(entries.map((e) => e.personId)).toEqual([ctx.personX]);
      expect(await statusOf()).toEqual({ status: "active", matches_served: 0 });
      expect(await noticesOf("suspension_served", id)).toEqual([]);

      // The division page is untouched: its reader still serves on read.
      const [orgSlug, compSlug, divSlug] = await slugsOf(ctx);
      expect(await publicSuspensions(orgSlug, compSlug, divSlug)).toEqual([]);
      expect(await statusOf()).toEqual({ status: "served", matches_served: 1 });
      expect(await noticesOf("suspension_served", id)).toHaveLength(1);
    });

    it("the division page's reader keeps its 404 for a division a spectator cannot see", async () => {
      const ctx = await seedFootballDivision();
      const [orgSlug, compSlug] = await slugsOf(ctx);
      await expect(publicSuspensions(orgSlug, compSlug, "no-such-division")).rejects.toMatchObject({ status: 404 });
    });
  });
});
