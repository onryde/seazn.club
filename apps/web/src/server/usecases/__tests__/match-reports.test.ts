// PROMPT-80 — official match reports + the SPEC-1 bridge. DB-backed; skipped
// without DATABASE_URL. Reports run on the cross-org superuser rail (the
// official is not an org member), so these tests assert: claimed-official
// identity (404), the window incl. abandoned, draft round-trip, submit
// immutability (409), organiser fixtureReports (submitted only), and the soft
// bridge — pending suspension on a named red card, dark on missing person /
// discipline / table.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql, withTenant } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { MAX_EXPIRY_MS, idempotencyKey, type OutboxStatus } from "@/server/email-outbox/constants";
import { dictionarySubject } from "@/server/email-outbox/__tests__/_kind-harness";
import { stubOutboxEnv } from "./_invite-mail";

// The report notice is RENDERED by `reportSubmittedEmail` and queued on the email outbox (phase 3 wave 4, kind
// `match_report_submitted`) in the submit's transaction. The builder is WRAPPED, never replaced: the real render runs,
// and the spy records what each notice was built from (the fixture line, the official, the incident count). vi.hoisted so
// the spy exists before the hoisted factory runs; the rest of the module is the real one (importOriginal).
const mail = vi.hoisted(() => ({ report: vi.fn<typeof import("@/lib/email").reportSubmittedEmail>() }));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  mail.report.mockImplementation(actual.reportSubmittedEmail);
  return { ...actual, reportSubmittedEmail: mail.report };
});
// The outbox's one network seam: captured, never sent. The row, the seal, the gate and the attempt are the real ones.
const transport = vi.hoisted(() => ({ deliver: vi.fn() }));
vi.mock("@/server/email-outbox/transport", () => ({ deliver: transport.deliver }));

import {
  __setBridgeProbeForTests,
  fixtureReports,
  getMyReport,
  myFixtureSquad,
  putMyReport,
  submitMyReport,
  type ReportIncident,
} from "../match-reports";

import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { makeAssignment, makeClaimedOfficial } from "./_seed";
const HAS_DB = !!process.env.DATABASE_URL;

interface OrgCtx {
  auth: AuthCtx;
  orgId: string;
  userId: string;
  divisionId: string;
  stageId: string;
  entrantA: string;
  entrantB: string;
}

async function seedOrg(plan: "pro" | "community" = "pro"): Promise<OrgCtx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`rep-${suffix}@test.local`}, 'Rep', true) returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Rep " + suffix}, ${"rep-" + suffix}, ${userId}) returning id`;
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
    values (${compId}, ${orgId}, 'Open', 'open', 'football', '11-a-side', ${sql.json({})}, '1.0.0')
    returning id`;
  const [{ id: stageId }] = await sql<{ id: string }[]>`
    insert into stages (division_id, org_id, seq, kind, name)
    values (${divisionId}, ${orgId}, 1, 'league', 'League') returning id`;
  const [{ id: entrantA }] = await sql<{ id: string }[]>`
    insert into entrants (division_id, org_id, kind, display_name, seed)
    values (${divisionId}, ${orgId}, 'team', 'Alpha', 1) returning id`;
  const [{ id: entrantB }] = await sql<{ id: string }[]>`
    insert into entrants (division_id, org_id, kind, display_name, seed)
    values (${divisionId}, ${orgId}, 'team', 'Bravo', 2) returning id`;
  return {
    auth: { orgId, via: "session", userId, role: "owner", keyId: null },
    orgId,
    userId,
    divisionId,
    stageId,
    entrantA,
    entrantB,
  };
}

async function makePlayer(ctx: OrgCtx): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name) values (${ctx.orgId}, 'Player Nine') returning id`;
  return id;
}

/** Roster a fresh person onto an entrant (entrant_members) so myFixtureSquad
 *  can surface them in the report person picker. */
async function rosterMember(ctx: OrgCtx, entrantId: string, name: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name) values (${ctx.orgId}, ${name}) returning id`;
  await sql`insert into entrant_members (entrant_id, person_id) values (${entrantId}, ${id})`;
  return id;
}

async function pendingReportSuspensions(
  divisionId: string,
): Promise<{ person_id: string; reason: string; status: string; bucket: number }[]> {
  return sql`
    select person_id, reason, status, bucket from suspensions
    where division_id = ${divisionId} and source = 'report' order by bucket`;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("match reports (SPEC-3, PROMPT-80)", () => {
  beforeEach(() => {
    mail.report.mockClear();
    // The outbox seals the body and the gate lets the attempt through; the transport answers as Resend would.
    stubOutboxEnv();
    transport.deliver.mockReset();
    transport.deliver.mockImplementation(async () => ({ ok: true, providerId: `re_test_${randomUUID()}` }));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("404s when the assignment isn't the caller's claimed official", async () => {
    const ctx = await seedOrg();
    const ref = await makeClaimedOfficial(ctx);
    const { fixtureOfficialId } = await makeAssignment(ctx, ref.officialId);
    // A different (unrelated) logged-in user.
    const [{ id: stranger }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${`x-${randomUUID().slice(0, 8)}@test.local`}, 'X', true) returning id`;
    await expect(getMyReport(stranger, fixtureOfficialId)).rejects.toMatchObject({ status: 404 });
    await expect(
      putMyReport(stranger, fixtureOfficialId, { body: "hi", incidents: [] }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("blocks a report before the fixture ends, allows it once abandoned", async () => {
    const ctx = await seedOrg();
    const ref = await makeClaimedOfficial(ctx);
    const scheduled = await makeAssignment(ctx, ref.officialId, {
      status: "scheduled",
    });
    await expect(
      putMyReport(ref.userId, scheduled.fixtureOfficialId, {
        body: "x",
        incidents: [],
      }),
    ).rejects.toMatchObject({ status: 403 });

    const abandoned = await makeAssignment(ctx, ref.officialId, {
      status: "abandoned",
    });
    const saved = await putMyReport(ref.userId, abandoned.fixtureOfficialId, {
      body: "rain stopped play",
      incidents: [],
    });
    expect(saved.status).toBe("draft");
    expect(saved.body).toBe("rain stopped play");
  });

  it("round-trips a draft and makes a submitted report immutable (409)", async () => {
    const ctx = await seedOrg();
    const ref = await makeClaimedOfficial(ctx);
    const { fixtureOfficialId } = await makeAssignment(ctx, ref.officialId);

    expect(await getMyReport(ref.userId, fixtureOfficialId)).toBeNull();
    await putMyReport(ref.userId, fixtureOfficialId, {
      body: "clean game",
      incidents: [{ kind: "injury", note: "twisted ankle 40'" }],
    });
    const got = await getMyReport(ref.userId, fixtureOfficialId);
    expect(got).toMatchObject({ status: "draft", body: "clean game" });
    expect(got!.incidents).toEqual([{ kind: "injury", note: "twisted ankle 40'" }]);

    const submitted = await submitMyReport(ref.userId, fixtureOfficialId);
    expect(submitted.status).toBe("submitted");
    expect(submitted.submittedAt).not.toBeNull();

    // Editing after submit → 409; resubmitting → 409.
    await expect(
      putMyReport(ref.userId, fixtureOfficialId, {
        body: "changed",
        incidents: [],
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(submitMyReport(ref.userId, fixtureOfficialId)).rejects.toMatchObject({
      status: 409,
    });
  });

  it("re-closes the window when a fixture is voided back to scheduled after a draft exists", async () => {
    const ctx = await seedOrg();
    const ref = await makeClaimedOfficial(ctx);
    const { fixtureOfficialId, fixtureId } = await makeAssignment(ctx, ref.officialId);
    const saved = await putMyReport(ref.userId, fixtureOfficialId, {
      body: "first draft",
      incidents: [],
    });
    expect(saved.status).toBe("draft");

    // Void the decision back to scheduled — the report window closes again even
    // though a draft already exists (the window is derived from fixture status
    // on every write, never cached on the report row).
    await sql`update fixtures set status = 'scheduled' where id = ${fixtureId}`;
    await expect(
      putMyReport(ref.userId, fixtureOfficialId, {
        body: "second draft",
        incidents: [],
      }),
    ).rejects.toMatchObject({ status: 403, code: "REPORT_WINDOW_CLOSED" });
  });

  it("organiser fixtureReports returns submitted reports only", async () => {
    const ctx = await seedOrg();
    const ref1 = await makeClaimedOfficial(ctx);
    const ref2 = await makeClaimedOfficial(ctx);
    const a1 = await makeAssignment(ctx, ref1.officialId);
    // Two officials on the SAME fixture: a submitted one and a draft one.
    const [{ id: foId2 }] = await sql<{ id: string }[]>`
      insert into fixture_officials (fixture_id, official_id, org_id, role_key, source, response)
      values (${a1.fixtureId}, ${ref2.officialId}, ${ctx.orgId}, 'assistant', 'manual', 'accepted')
      returning id`;

    await putMyReport(ref1.userId, a1.fixtureOfficialId, {
      body: "ref one",
      incidents: [],
    });
    await submitMyReport(ref1.userId, a1.fixtureOfficialId);
    await putMyReport(ref2.userId, foId2, {
      body: "ref two draft",
      incidents: [],
    });

    const reports = await fixtureReports(ctx.auth, a1.fixtureId);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      status: "submitted",
      body: "ref one",
      officialName: "The Ref",
    });
  });

  it("org B's fixtureReports never sees org A's submitted report (RLS)", async () => {
    const a = await seedOrg();
    const b = await seedOrg();
    const ref = await makeClaimedOfficial(a);
    const { fixtureOfficialId, fixtureId } = await makeAssignment(a, ref.officialId);
    await putMyReport(ref.userId, fixtureOfficialId, {
      body: "org a only",
      incidents: [],
    });
    await submitMyReport(ref.userId, fixtureOfficialId);

    // Sanity: the raw superuser connection DOES see org A's row, so the tenant
    // assertion below is meaningful (not vacuously zero).
    const [{ raw }] = await sql<{ raw: number }[]>`
      select count(*)::int as raw from match_reports where fixture_official_id = ${fixtureOfficialId}`;
    expect(raw).toBe(1);

    // Through org B's tenant rail, RLS hides org A's row entirely.
    const seen = await withTenant(b.orgId, async (tx) => {
      const [r] = await tx<{ c: number }[]>`
        select count(*)::int as c from match_reports where fixture_official_id = ${fixtureOfficialId}`;
      return r!.c;
    });
    expect(seen).toBe(0);
    // And org B's fixtureReports for org A's fixture reports empty.
    expect(await fixtureReports(b.auth, fixtureId)).toEqual([]);
  });

  it("bridges a named red card into a pending report-suspension (SPEC-1)", async () => {
    const ctx = await seedOrg("pro"); // pro → discipline.enforced true (V293)
    const ref = await makeClaimedOfficial(ctx);
    const player = await makePlayer(ctx);
    const { fixtureOfficialId } = await makeAssignment(ctx, ref.officialId);

    const incidents: ReportIncident[] = [
      {
        kind: "red_card",
        person_id: player,
        entrant_id: ctx.entrantA,
        note: "violent conduct, 88'",
      },
      { kind: "injury", note: "keeper concussion" },
    ];
    await putMyReport(ref.userId, fixtureOfficialId, {
      body: "eventful",
      incidents,
    });
    await submitMyReport(ref.userId, fixtureOfficialId);

    const rows = await pendingReportSuspensions(ctx.divisionId);
    expect(rows).toHaveLength(1); // only the red card, not the injury
    expect(rows[0]).toMatchObject({
      person_id: player,
      reason: "violent conduct, 88'",
      status: "pending",
      bucket: 0,
    });
  });

  it("does not bridge an anonymous incident nor when the org lacks discipline.enforced", async () => {
    // (a) red card with no person → no row.
    const pro = await seedOrg("pro");
    const refP = await makeClaimedOfficial(pro);
    const anon = await makeAssignment(pro, refP.officialId);
    await putMyReport(refP.userId, anon.fixtureOfficialId, {
      body: "b",
      incidents: [{ kind: "red_card", note: "no name" }],
    });
    await submitMyReport(refP.userId, anon.fixtureOfficialId);
    expect(await pendingReportSuspensions(pro.divisionId)).toHaveLength(0);

    // (b) community org (discipline.enforced false) → report files, no bridge.
    const comm = await seedOrg("community");
    const refC = await makeClaimedOfficial(comm);
    const player = await makePlayer(comm);
    const asg = await makeAssignment(comm, refC.officialId);
    await putMyReport(refC.userId, asg.fixtureOfficialId, {
      body: "b",
      incidents: [{ kind: "red_card", person_id: player, note: "sent off" }],
    });
    const submitted = await submitMyReport(refC.userId, asg.fixtureOfficialId);
    expect(submitted.status).toBe("submitted");
    expect(await pendingReportSuspensions(comm.divisionId)).toHaveLength(0);
  });

  it("bridge safety: a person_id crafted from another org is skipped, not inserted, and never throws", async () => {
    const ctx = await seedOrg("pro"); // pro → discipline.enforced true
    const other = await seedOrg("pro"); // a different org — its person is foreign here
    const foreignPlayer = await makePlayer(other);
    const ref = await makeClaimedOfficial(ctx);
    const { fixtureOfficialId } = await makeAssignment(ctx, ref.officialId);

    // PUT accepts the incident payload as-is (no cross-org FK check on write) —
    // craft a red card naming a person from a different org.
    await putMyReport(ref.userId, fixtureOfficialId, {
      body: "eventful",
      incidents: [{ kind: "red_card", person_id: foreignPlayer, note: "violent conduct" }],
    });

    // Submit must not throw, and the bridge's org-scoped validity check must
    // silently skip the foreign id — no suspension row, in EITHER division.
    const submitted = await submitMyReport(ref.userId, fixtureOfficialId);
    expect(submitted.status).toBe("submitted");
    expect(await pendingReportSuspensions(ctx.divisionId)).toHaveLength(0);
    const [{ count: foreignCount }] = await sql<{ count: number }[]>`
      select count(*)::int as count from suspensions where person_id = ${foreignPlayer}`;
    expect(foreignCount).toBe(0);
  });

  it("ships dark: submit succeeds with no error when the suspensions table is absent", async () => {
    const ctx = await seedOrg("pro");
    const ref = await makeClaimedOfficial(ctx);
    const player = await makePlayer(ctx);
    const { fixtureOfficialId } = await makeAssignment(ctx, ref.officialId);
    await putMyReport(ref.userId, fixtureOfficialId, {
      body: "b",
      incidents: [{ kind: "red_card", person_id: player, note: "sent off" }],
    });

    // Simulate the pre-V293 world where the SPEC-1 table doesn't exist yet: the
    // bridge's existence probe reports absent. Injected via the module seam so
    // we never rename the shared `suspensions` table — a rename would flake a
    // thread-parallel discipline.test.ts run against the one local DB. Restore
    // the real probe unconditionally.
    __setBridgeProbeForTests(async () => false);
    try {
      const submitted = await submitMyReport(ref.userId, fixtureOfficialId);
      expect(submitted.status).toBe("submitted");
      // Dark: despite a named red card + discipline.enforced, no suspension row.
      expect(await pendingReportSuspensions(ctx.divisionId)).toHaveLength(0);
    } finally {
      __setBridgeProbeForTests(null);
    }
  });

  it("myFixtureSquad returns both entrants' members for the caller (404 for a stranger)", async () => {
    const ctx = await seedOrg();
    const ref = await makeClaimedOfficial(ctx);
    const { fixtureOfficialId } = await makeAssignment(ctx, ref.officialId);
    const pA = await rosterMember(ctx, ctx.entrantA, "Home Player");
    const pB = await rosterMember(ctx, ctx.entrantB, "Away Player");

    const squad = await myFixtureSquad(ref.userId, fixtureOfficialId);
    const ids = squad.map((m) => m.person_id);
    expect(ids).toContain(pA);
    expect(ids).toContain(pB);
    expect(squad.find((m) => m.person_id === pA)).toMatchObject({
      full_name: "Home Player",
      entrant_name: "Alpha",
    });

    const [{ id: stranger }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${`x-${randomUUID().slice(0, 8)}@test.local`}, 'X', true) returning id`;
    await expect(myFixtureSquad(stranger, fixtureOfficialId)).rejects.toMatchObject({
      status: 404,
    });
  });

  // Phase 3 wave 4 (T3, kind `match_report_submitted`): a submitted report queues one notice per org owner and admin, in
  // the submit's own transaction (R1), only when that submit flipped the draft (R6: a resubmit is refused 409 and queues
  // nothing). Each notice is about the report (`match_report / <reportId>`), addressed to the member's ACCOUNT, in their
  // language (D4: the account's, then the org's default, then `en`), once per member (once-key `<reportId>:<userId>`);
  // the request makes the first attempt after commit (R5). A deleted account gets nothing.
  // Not built (owner rule 2026-10-26, mainstream only): a rollback witnessed by a failing statement after the enqueue
  // (`plantFailingUpdate` does not exist); the rows share the submit's transaction by construction.
  // Sport: not applicable (the notice does not vary by sport; the report seeds are football).
  describe("the report notice goes through the email outbox (match_report_submitted)", () => {
    type NoticeRow = {
      id: string; ref_type: string; ref_id: string; dedupe_key: string | null; org_id: string | null; recipient: string;
      recipient_user_id: string | null; transactional: boolean; subject: string; status: OutboxStatus; created_at: Date; expires_at: Date;
    };
    /** Every report notice about `reportId`, by recipient. */
    const noticesOf = (reportId: string) =>
      sql<NoticeRow[]>`
        select id, ref_type, ref_id, dedupe_key, org_id, recipient, recipient_user_id, transactional, subject, status, created_at, expires_at
          from email_outbox where kind = 'match_report_submitted' and ref_type = 'match_report' and ref_id = ${reportId}
         order by recipient`;
    /** The notices once the request's own first attempt (a deferred `dispatchNow`) is over: none left queued or sending. */
    const settledNoticesOf = async (reportId: string) => {
      await vi.waitFor(
        async () => {
          const rows = await noticesOf(reportId);
          expect(rows.filter((r) => r.status === "queued" || r.status === "sending"), "the request's first attempt is over").toEqual([]);
        },
        { timeout: 15_000, interval: 100 },
      );
      return noticesOf(reportId);
    };
    const subjectIn = (locale: "en" | "fr" | "es" | "nl") => dictionarySubject(locale, "reportSubmitted.subject", { fixture: "Alpha vs Bravo" });
    /** A member of the org at a fresh address, with this role and account language. */
    const member = async (orgId: string, role: "owner" | "admin" | "viewer", locale: string | null) => {
      const email = `${role}-${randomUUID().slice(0, 8)}@test.local`;
      const [{ id }] = await sql<{ id: string }[]>`
        insert into users (email, display_name, email_verified, locale) values (${email}, ${role}, true, ${locale}) returning id`;
      await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${id}, ${role})`;
      return { id, email };
    };
    /** An org whose seeded owner has the language `ownerLocale`, an admin, a viewer, and a filed draft by its claimed official. */
    async function draftWithMembers(ownerLocale: string | null) {
      const ctx = await seedOrg();
      await sql`update organizations set default_locale = 'es' where id = ${ctx.orgId}`;
      const [owner] = await sql<{ email: string }[]>`update users set locale = ${ownerLocale} where id = ${ctx.userId} returning email`;
      const admin = await member(ctx.orgId, "admin", null);
      const viewer = await member(ctx.orgId, "viewer", "fr");
      const ref = await makeClaimedOfficial(ctx);
      const player = await rosterMember(ctx, ctx.entrantA, "Home Player");
      const { fixtureOfficialId } = await makeAssignment(ctx, ref.officialId);
      await putMyReport(ref.userId, fixtureOfficialId, {
        body: "eventful",
        incidents: [{ kind: "red_card", person_id: player, note: "sent off" }],
      });
      return { ctx, owner: { id: ctx.userId, email: owner!.email }, admin, viewer, ref, fixtureOfficialId };
    }

    it("a submitted report queues one notice per owner and admin, each in their own language", async () => {
      const { ctx, owner, admin, viewer, ref, fixtureOfficialId } = await draftWithMembers("fr");
      for (const l of ["fr", "es"] as const) expect(subjectIn(l), `premise: the ${l} subject is not the English one`).not.toBe(subjectIn("en"));

      const report = await submitMyReport(ref.userId, fixtureOfficialId);

      const rows = await settledNoticesOf(report.id);
      expect(
        rows.map((r) => ({ to: r.recipient, user: r.recipient_user_id, key: r.dedupe_key, subject: r.subject, status: r.status })),
        "the owner in their account's language, the admin (no language) in the org's; the viewer gets none",
      ).toEqual(
        [
          { to: owner.email, user: owner.id, key: `${report.id}:${owner.id}`, subject: subjectIn("fr"), status: "sent" },
          { to: admin.email, user: admin.id, key: `${report.id}:${admin.id}`, subject: subjectIn("es"), status: "sent" },
        ].sort((a, b) => a.to.localeCompare(b.to)),
      );
      expect(rows.map((r) => r.recipient)).not.toContain(viewer.email);
      for (const r of rows) {
        expect(r).toMatchObject({ ref_type: "match_report", ref_id: report.id, org_id: ctx.orgId, transactional: true });
        expect(Math.abs(r.expires_at.getTime() - r.created_at.getTime() - MAX_EXPIRY_MS), "the bound").toBeLessThan(1_000);
        // R5: the request made the first attempt after commit, once per row.
        expect(transport.deliver.mock.calls.filter((c) => (c[0] as { idempotencyKey: string }).idempotencyKey === idempotencyKey(r.id))).toHaveLength(1);
      }
      // Each notice was built from the report: the fixture line, the official, the incident count.
      expect(mail.report.mock.calls.map((c) => c[0])).toEqual([
        expect.objectContaining({ fixtureLine: "Alpha vs Bravo", officialName: "The Ref", incidentCount: 1 }),
        expect.objectContaining({ fixtureLine: "Alpha vs Bravo", officialName: "The Ref", incidentCount: 1 }),
      ]);
    });

    it("a second submit is refused (409) and queues nothing", async () => {
      const { ref, fixtureOfficialId } = await draftWithMembers("fr");
      const report = await submitMyReport(ref.userId, fixtureOfficialId);
      expect(await settledNoticesOf(report.id), "premise: the submit queued its two notices").toHaveLength(2);

      await expect(submitMyReport(ref.userId, fixtureOfficialId)).rejects.toMatchObject({ status: 409 });

      expect(await settledNoticesOf(report.id), "still two").toHaveLength(2);
      expect(mail.report.mock.calls, "and nothing more was built").toHaveLength(2);
    });

    it("two submits of one draft at once: one files it, the other is refused (409) inside its transaction, and the notices are queued once", async () => {
      const { ref, fixtureOfficialId } = await draftWithMembers("fr");
      // Park both submits on the draft's row lock, so each has already READ the draft (and passed the pre-check's 409) before the
      // guarded update; only the update's own re-check can refuse the loser.
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let staged!: (grip: { xid: string; page: number; tuple: number }) => void;
      const isStaged = new Promise<{ xid: string; page: number; tuple: number }>((resolve) => (staged = resolve));
      const holder = sql.begin(async (tx) => {
        const [row] = await tx<{ ctid: string; xid: string }[]>`
          select ctid::text as ctid, pg_current_xact_id()::text as xid
          from match_reports where fixture_official_id = ${fixtureOfficialId} for update`;
        const [page, tuple] = row!.ctid.replace(/[()]/g, "").split(",").map(Number);
        staged({ xid: row!.xid, page: page!, tuple: tuple! });
        await held;
      });
      holder.catch(() => {});
      const grip = await isStaged;
      const racing = Promise.allSettled([submitMyReport(ref.userId, fixtureOfficialId), submitMyReport(ref.userId, fixtureOfficialId)]);
      try {
        // Only waiters on THIS row: the first queues on the holder's transaction id, the second on the row's tuple lock.
        const deadline = Date.now() + 10_000;
        for (;;) {
          const [w] = await sql<{ n: number }[]>`
            select count(*)::int as n from pg_locks l
            where not l.granted
              and ((l.locktype = 'transactionid' and l.transactionid::text = ${grip.xid})
                or (l.locktype = 'tuple' and l.relation = 'match_reports'::regclass and l.page = ${grip.page} and l.tuple = ${grip.tuple}))`;
          if (w!.n >= 2) break;
          if (Date.now() > deadline) throw new Error(`only ${w!.n}/2 blocked submits appeared — race not staged`);
          await new Promise((r) => setTimeout(r, 25));
        }
      } finally {
        release();
        await holder;
      }
      const settled = await racing;

      const filed = settled.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof submitMyReport>>> => r.status === "fulfilled");
      const refused = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(filed, "one submit filed the report").toHaveLength(1);
      expect(refused.map((r) => r.reason), "the other was refused as a resubmit").toEqual([expect.objectContaining({ status: 409, code: "REPORT_SUBMITTED" })]);
      expect(await settledNoticesOf(filed[0]!.value.id), "one notice per owner and admin, once").toHaveLength(2);
      expect(mail.report.mock.calls, "built once per member").toHaveLength(2);
    });

    it("empty: a deleted admin gets no row", async () => {
      const { owner, admin, ref, fixtureOfficialId } = await draftWithMembers(null);
      await sql`update users set deleted_at = now() where id = ${admin.id}`;

      const report = await submitMyReport(ref.userId, fixtureOfficialId);

      expect((await settledNoticesOf(report.id)).map((r) => r.recipient_user_id), "the owner only").toEqual([owner.id]);
    });
  });
});
