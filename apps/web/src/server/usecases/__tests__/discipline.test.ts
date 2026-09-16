// PROMPT-78 — discipline fold/detection/serving (SPEC-1). DB-backed; skipped
// without DATABASE_URL. Seeds a football division with raw SQL, drops
// attributed card events into the ledger, and asserts the recompute-on-read
// fold: accumulation buckets, dismissal, idempotency, void un-count, anonymous
// exclusion, and the derived serving counter.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { builtinModules } from "@seazn/engine/sports";

// Observe the two SPEC-1 player notices without touching the rest of the email
// module (send() is a no-op without RESEND_API_KEY either way). Hoisted so the
// spies are live before ../discipline binds the senders at import.
const emailMock = vi.hoisted(() => ({
  confirmed: vi.fn().mockResolvedValue(true),
  served: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendSuspensionConfirmedEmail: emailMock.confirmed,
  sendSuspensionServedEmail: emailMock.served,
}));

// `after` wrapped, not replaced (the `lib/__tests__/deferred.test.ts` pattern):
// outside a request it still throws and `deferred` runs its task inline, except
// where one test captures the task to run it LATER, as a request's after-window
// would.
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: vi.fn(actual.after) };
});

import { after } from "next/server";
import { sql, withTenant } from "@/lib/db";
import { log } from "@/server/logger";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { PaymentRequiredError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
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
} from "../discipline";
import { refreshDiscipline, scoreEvent } from "../scoring";

import { setOrgPlan } from "@/lib/__tests__/_billing-group";
const HAS_DB = !!process.env.DATABASE_URL;

// Full football config snapshot (createDivision would store this) — needed so
// the seam test can fold a real forfeit through the module.
const FOOTBALL_CFG = builtinModules.find((m) => m.key === "football")!.configSchema.parse({});

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

interface Ctx {
  auth: AuthCtx;
  orgId: string;
  userId: string;
  divisionId: string;
  entrantA: string;
  entrantB: string;
  personX: string;
  personY: string;
  stageId: string;
}

async function seedFootballDivision(plan: "pro" | "community" = "pro"): Promise<Ctx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`disc-${suffix}@test.local`}, 'Disc', true) returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Disc " + suffix}, ${"disc-" + suffix}, ${userId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, 'owner')`;
  if (plan === "pro") {
    await setOrgPlan(orgId);
  }
  await invalidateOrgEntitlements(orgId);
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('football', 'Football', '1.0.0', ${sql.json({ groups: [], lineup: { size: 11, benchMax: 12 } })})
    on conflict (key) do nothing`;
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility, created_by)
    values (${orgId}, 'Cup', ${"cup-" + suffix}, 'public', ${userId}) returning id`;
  const [{ id: divisionId }] = await sql<{ id: string }[]>`
    insert into divisions (competition_id, org_id, name, slug, sport_key, variant_key, config, module_version)
    values (${compId}, ${orgId}, 'Open', 'open', 'football', '11-a-side', ${sql.json(FOOTBALL_CFG as never)}, '1.0.0')
    returning id`;
  const [{ id: stageId }] = await sql<{ id: string }[]>`
    insert into stages (division_id, org_id, seq, kind, name) values (${divisionId}, ${orgId}, 1, 'league', 'League')
    returning id`;
  const [{ id: entrantA }] = await sql<{ id: string }[]>`
    insert into entrants (division_id, org_id, kind, display_name, seed) values (${divisionId}, ${orgId}, 'team', 'A', 1) returning id`;
  const [{ id: entrantB }] = await sql<{ id: string }[]>`
    insert into entrants (division_id, org_id, kind, display_name, seed) values (${divisionId}, ${orgId}, 'team', 'B', 2) returning id`;
  const [{ id: personX }] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name) values (${orgId}, 'Xavier Smith') returning id`;
  const [{ id: personY }] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name) values (${orgId}, 'Yousef Kane') returning id`;
  await sql`insert into entrant_members (entrant_id, person_id, org_id) values (${entrantA}, ${personX}, ${orgId})`;
  await sql`insert into entrant_members (entrant_id, person_id, org_id) values (${entrantB}, ${personY}, ${orgId})`;
  return {
    auth: { orgId, via: "session", userId, role: "owner", keyId: null },
    orgId,
    userId,
    divisionId,
    entrantA,
    entrantB,
    personX,
    personY,
    stageId,
  };
}

/** Link a person to a claimed user account so the confirmed/served notices
 *  have an inbox to resolve (the senders join persons→users→email). */
async function claimPerson(personId: string, email: string): Promise<void> {
  const [{ id: uid }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${email}, 'Claimed', true) returning id`;
  await sql`update persons set user_id = ${uid} where id = ${personId}`;
}

async function makeFixture(
  ctx: Ctx,
  seqInRound: number,
  home: string | null,
  away: string | null,
  status = "scheduled",
): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, home_entrant_id, away_entrant_id, status)
    values (${ctx.stageId}, ${ctx.divisionId}, ${ctx.orgId}, 1, ${seqInRound}, ${home}, ${away}, ${status})
    returning id`;
  return id;
}

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

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("discipline fold (SPEC-1, PROMPT-78)", () => {
  beforeEach(() => {
    emailMock.confirmed.mockClear();
    emailMock.served.mockClear();
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

  it("confirming a suspension fires the confirmed email to the claimed player", async () => {
    const ctx = await seedFootballDivision();
    const email = `claim-${randomUUID().slice(0, 8)}@test.local`;
    await claimPerson(ctx.personX, email);
    const manual = await createManualSuspension(ctx.auth, ctx.divisionId, {
      personId: ctx.personX,
      matchesTotal: 2,
      reason: "violent conduct",
    });

    const active = await decideSuspension(ctx.auth, manual.id, {
      kind: "confirm",
    });
    expect(active.status).toBe("active");
    // The confirmed sender fired exactly once, to this player's inbox. Remove the
    // `await emailConfirmed(...)` wiring in decideSuspension and this goes to 0.
    expect(emailMock.confirmed).toHaveBeenCalledTimes(1);
    expect(emailMock.confirmed.mock.calls[0]![0]).toBe(email);
    expect(emailMock.served).not.toHaveBeenCalled();
  });

  it("the active→served flip fires the served email once", async () => {
    const ctx = await seedFootballDivision();
    const email = `claim-${randomUUID().slice(0, 8)}@test.local`;
    await claimPerson(ctx.personX, email);
    const manual = await createManualSuspension(ctx.auth, ctx.divisionId, {
      personId: ctx.personX,
      matchesTotal: 1,
      reason: "violent conduct",
    });
    const active = await decideSuspension(ctx.auth, manual.id, {
      kind: "confirm",
    });
    expect(active.entrantId).toBe(ctx.entrantA);

    // A decided fixture for the banned entrant, stamped after the ban's decided_at,
    // serves the one-match ban. The recompute-on-read flips active→served.
    const fx = await makeFixture(ctx, 2, ctx.entrantA, ctx.entrantB, "decided");
    await sql`
      insert into score_events (fixture_id, org_id, seq, type, payload, recorded_at)
      values (${fx}, ${ctx.orgId}, ${nextSeq(fx)}, 'core.note', ${sql.json({ text: "d" })},
              now() + interval '1 hour')`;

    emailMock.served.mockClear();
    const served = (await listSuspensions(ctx.auth, ctx.divisionId)).find(
      (r) => r.id === manual.id,
    )!;
    expect(served.status).toBe("served");
    // The served sender fired exactly once on the flip. Remove `await emailServed(...)`
    // and this goes to 0; a second read must not re-fire it.
    expect(emailMock.served).toHaveBeenCalledTimes(1);
    expect(emailMock.served.mock.calls[0]![0]).toBe(email);
    await listSuspensions(ctx.auth, ctx.divisionId);
    expect(emailMock.served).toHaveBeenCalledTimes(1);
  });

  // The division page used to be what served a manual ban in a division whose
  // auto-discipline is OFF: `refreshDiscipline` returned before folding unless a
  // rules row was enabled, so the only thing that ever advanced the counter was
  // a public read. The competition hub reads bans without writing, so the WRITE
  // path has to serve them itself. Read the row directly: every discipline
  // reader serves on read and would hide a write path that does not.
  it("discipline OFF: the score that serves a manual ban flips it on the write path, with one served email", async () => {
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
    emailMock.served.mockClear();

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
    expect(emailMock.served).toHaveBeenCalledTimes(1);
    expect(emailMock.served.mock.calls[0]![0]).toBe(email);
    // Running the write-path fold again finds nothing active: no second email.
    await refreshDiscipline(ctx.auth, fx);
    expect(emailMock.served).toHaveBeenCalledTimes(1);
  });

  // Two serving passes can read ONE active ban at the same time: a decided
  // score write (`refreshDiscipline`) against a division page read
  // (`publicSuspensions` still serves on read), or two decided writes in one
  // division (two courts finishing together). Each computes "served"; only one
  // may flip the row, and only the flip that COMMITTED may send the email.
  describe("serving under concurrency — one flip, one served email, sent after commit", () => {
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
      emailMock.served.mockClear();
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

    it("a decided score write and a division page read, together: one flip, ONE served email", async () => {
      const { ctx, banId, fixtures, slugs } = await dueBan();
      await race<unknown>(banId, () => [refreshDiscipline(ctx.auth, fixtures[0]!), publicSuspensions(...slugs)]);
      expect(await statusOf(banId)).toEqual({ status: "served", matches_served: 1 });
      expect(emailMock.served).toHaveBeenCalledTimes(1);
    });

    it("two decided score writes in one division, together: one flip, ONE served email", async () => {
      const { ctx, banId, fixtures } = await dueBan();
      await race(banId, () => [refreshDiscipline(ctx.auth, fixtures[0]!), refreshDiscipline(ctx.auth, fixtures[1]!)]);
      expect(await statusOf(banId)).toEqual({ status: "served", matches_served: 1 });
      expect(emailMock.served).toHaveBeenCalledTimes(1);
    });

    it("exactly ONE of two racing passes reports the flip — the other's guarded update matched nothing", async () => {
      const { ctx, banId } = await dueBan();
      const flips = await race(banId, () => [
        withTenant(ctx.orgId, (tx) => detectSuspensions(tx, ctx.divisionId)),
        withTenant(ctx.orgId, (tx) => detectSuspensions(tx, ctx.divisionId)),
      ]);
      expect(flips.flat().map((flip) => flip.id)).toEqual([banId]);
      // The pass itself never mails: its caller does, once the flip is committed.
      expect(emailMock.served).not.toHaveBeenCalled();
    });

    it("a serving pass whose transaction ROLLS BACK sends nothing; the next committed pass flips it and sends the one email", async () => {
      const { ctx, banId } = await dueBan();
      await expect(
        withTenant(ctx.orgId, async (tx) => {
          await detectSuspensions(tx, ctx.divisionId);
          throw new Error("rolled back after serving");
        }),
      ).rejects.toThrow("rolled back after serving");
      expect(await statusOf(banId)).toEqual({ status: "active", matches_served: 0 });
      expect(emailMock.served).not.toHaveBeenCalled();

      await listSuspensions(ctx.auth, ctx.divisionId);
      expect(await statusOf(banId)).toEqual({ status: "served", matches_served: 1 });
      expect(emailMock.served).toHaveBeenCalledTimes(1);
    });

    // `activeSuspensionsByEntrant` serves inside a transaction its CALLER owns
    // (the organiser division page), so it cannot send after a commit it
    // never sees: it hands the flip to a notice that waits for that
    // transaction to end and mails only a flip that committed.
    it("the entrant-chip read serves inside its caller's transaction: nothing if that rolls back, one email once it commits", async () => {
      const { ctx, banId } = await dueBan();
      await expect(
        withTenant(ctx.orgId, async (tx) => {
          await activeSuspensionsByEntrant(tx, ctx.divisionId);
          throw new Error("caller rolled back");
        }),
      ).rejects.toThrow("caller rolled back");
      await new Promise((r) => setTimeout(r, 500));
      expect(await statusOf(banId)).toEqual({ status: "active", matches_served: 0 });
      expect(emailMock.served).not.toHaveBeenCalled();

      await withTenant(ctx.orgId, (tx) => activeSuspensionsByEntrant(tx, ctx.divisionId));
      await expect.poll(() => emailMock.served.mock.calls.length, { timeout: 5_000 }).toBe(1);
      expect(await statusOf(banId)).toEqual({ status: "served", matches_served: 1 });
      await new Promise((r) => setTimeout(r, 300));
      expect(emailMock.served).toHaveBeenCalledTimes(1);
    });

    // The notice checks THIS pass's flip, not merely that the row is served: a
    // served row flipped by someone else carries someone else's email.
    it("an entrant-chip notice that runs after its caller ROLLED BACK and another pass flipped and committed sends nothing — the other pass's own notice is the one email", async () => {
      const { ctx, banId } = await dueBan();
      // Capture the tail work instead of running it inline, as a request's
      // after-window would run it later.
      let notice: (() => unknown) | undefined;
      vi.mocked(after).mockImplementationOnce((task) => {
        notice = task as () => unknown;
      });
      await expect(
        withTenant(ctx.orgId, async (tx) => {
          await activeSuspensionsByEntrant(tx, ctx.divisionId);
          throw new Error("caller rolled back");
        }),
      ).rejects.toThrow("caller rolled back");
      expect(notice).toBeTypeOf("function");

      // Another pass flips the ban for real, commits and mails.
      await listSuspensions(ctx.auth, ctx.divisionId);
      expect(await statusOf(banId)).toEqual({ status: "served", matches_served: 1 });
      expect(emailMock.served).toHaveBeenCalledTimes(1);

      // Now the rolled-back pass's notice runs: the row IS served, but not by it.
      await notice!();
      expect(emailMock.served).toHaveBeenCalledTimes(1);
    });
  });

  // A notice runs after the write committed. If it throws, the write still
  // stands — so it must not make the write look failed.
  describe("a served notice that fails never fails the write that committed", () => {
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      warn = vi.spyOn(log, "warn").mockImplementation(() => undefined as never);
    });
    // `log` is a module singleton: an unrestored spy leaks into every later test.
    afterEach(() => {
      warn.mockRestore();
    });

    async function forfeitServesBan() {
      const ctx = await seedFootballDivision();
      await sql`update divisions set status = 'active' where id = ${ctx.divisionId}`;
      await claimPerson(ctx.personX, `claim-${randomUUID().slice(0, 8)}@test.local`);
      const manual = await createManualSuspension(ctx.auth, ctx.divisionId, {
        personId: ctx.personX,
        matchesTotal: 1,
        reason: "violent conduct",
      });
      await decideSuspension(ctx.auth, manual.id, { kind: "confirm" });
      const fx = await makeFixture(ctx, 2, ctx.entrantA, ctx.entrantB);
      return { ctx, banId: manual.id, fx };
    }

    it("the notifier THROWS after the score committed: scoreEvent still resolves, the result and the flip both stand, and a warning is logged", async () => {
      const { ctx, banId, fx } = await forfeitServesBan();
      emailMock.served.mockImplementationOnce(() => {
        throw new Error("mail client blew up");
      });

      await expect(
        scoreEvent(ctx.auth, fx, { expected_seq: 0, type: "core.forfeit", payload: { by: ctx.entrantA, reason: "walkover" } }),
      ).resolves.toBeDefined();

      const [fixture] = await sql<{ status: string }[]>`select status from fixtures where id = ${fx}`;
      expect(fixture!.status).toBe("forfeited");
      const [ban] = await sql<{ status: string }[]>`select status from suspensions where id = ${banId}`;
      expect(ban!.status).toBe("served");
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ suspensionIds: [banId], err: "mail client blew up" }),
        "discipline: the served notice failed after commit; the ban stands served",
      );
    });

    it("a served email whose send REJECTS is logged, never silently dropped", async () => {
      const { ctx, banId, fx } = await forfeitServesBan();
      emailMock.served.mockRejectedValueOnce(new Error("provider 503"));
      await scoreEvent(ctx.auth, fx, { expected_seq: 0, type: "core.forfeit", payload: { by: ctx.entrantA, reason: "walkover" } });
      await expect
        .poll(() => warn.mock.calls.some((c: unknown[]) => (c[1] as string) === "discipline: a served email failed to send"))
        .toBe(true);
      const call = warn.mock.calls.find((c: unknown[]) => (c[1] as string) === "discipline: a served email failed to send")!;
      expect(call[0]).toMatchObject({ suspensionId: banId, err: "provider 503" });
    });

    it("the CONFIRMED notice throwing does not fail the decision that committed, and a warning is logged", async () => {
      const ctx = await seedFootballDivision();
      await claimPerson(ctx.personX, `claim-${randomUUID().slice(0, 8)}@test.local`);
      const manual = await createManualSuspension(ctx.auth, ctx.divisionId, {
        personId: ctx.personX,
        matchesTotal: 1,
        reason: "violent conduct",
      });
      emailMock.confirmed.mockImplementationOnce(() => {
        throw new Error("mail client blew up");
      });
      await expect(decideSuspension(ctx.auth, manual.id, { kind: "confirm" })).resolves.toMatchObject({
        status: "active",
      });
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ suspensionId: manual.id, err: "mail client blew up" }),
        "discipline: the confirmed notice failed after commit; the decision stands",
      );
    });

    it("a confirmed email whose send REJECTS is logged, never silently dropped", async () => {
      const ctx = await seedFootballDivision();
      await claimPerson(ctx.personX, `claim-${randomUUID().slice(0, 8)}@test.local`);
      const manual = await createManualSuspension(ctx.auth, ctx.divisionId, {
        personId: ctx.personX,
        matchesTotal: 1,
        reason: "violent conduct",
      });
      emailMock.confirmed.mockRejectedValueOnce(new Error("provider 503"));
      await decideSuspension(ctx.auth, manual.id, { kind: "confirm" });
      await expect
        .poll(() => warn.mock.calls.some((c: unknown[]) => (c[1] as string) === "discipline: a confirmed email failed to send"))
        .toBe(true);
      const call = warn.mock.calls.find((c: unknown[]) => (c[1] as string) === "discipline: a confirmed email failed to send")!;
      expect(call[0]).toMatchObject({ suspensionId: manual.id, err: "provider 503" });
    });
  });

  it("waive: excluded from activeSuspensionsByEntrant/publicSuspensions; served email never fires", async () => {
    const ctx = await seedFootballDivision();
    const email = `claim-${randomUUID().slice(0, 8)}@test.local`;
    await claimPerson(ctx.personX, email);
    const manual = await createManualSuspension(ctx.auth, ctx.divisionId, {
      personId: ctx.personX,
      matchesTotal: 1,
      reason: "dissent",
    });
    const active = await decideSuspension(ctx.auth, manual.id, {
      kind: "confirm",
    });
    expect(active.status).toBe("active");
    emailMock.served.mockClear();

    const waived = await decideSuspension(ctx.auth, manual.id, {
      kind: "waive",
    });
    expect(waived.status).toBe("waived");

    const byEntrant = await withTenant(ctx.orgId, (tx) =>
      activeSuspensionsByEntrant(tx, ctx.divisionId),
    );
    expect(byEntrant.get(ctx.entrantA) ?? []).toHaveLength(0);

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
    expect(pub).toEqual([]); // waived is neither active nor listed publicly

    // A further recompute-on-read pass (listSuspensions) must not fire the
    // served notice for a waived row — it never enters the `active` set.
    await listSuspensions(ctx.auth, ctx.divisionId);
    expect(emailMock.served).not.toHaveBeenCalled();
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

    it("READ-ONLY: a ban a result has already served stays active in the table, is still listed, and no served email fires — the division page's reader still serves it", async () => {
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
      emailMock.served.mockClear();

      const entries = await activePublicSuspensionEntries([ctx.divisionId]);
      expect(entries.map((e) => e.personId)).toEqual([ctx.personX]);
      expect(await statusOf()).toEqual({ status: "active", matches_served: 0 });
      expect(emailMock.served).not.toHaveBeenCalled();

      // The division page is untouched: its reader still serves on read.
      const [orgSlug, compSlug, divSlug] = await slugsOf(ctx);
      expect(await publicSuspensions(orgSlug, compSlug, divSlug)).toEqual([]);
      expect(await statusOf()).toEqual({ status: "served", matches_served: 1 });
      expect(emailMock.served).toHaveBeenCalledTimes(1);
    });

    it("the division page's reader keeps its 404 for a division a spectator cannot see", async () => {
      const ctx = await seedFootballDivision();
      const [orgSlug, compSlug] = await slugsOf(ctx);
      await expect(publicSuspensions(orgSlug, compSlug, "no-such-division")).rejects.toMatchObject({ status: 404 });
    });
  });
});
