// PROMPT-63 — the per-match audit ledger read: full stream with V226 chain
// columns, verifier verdict, tamper localisation; plus the V288 entitlement
// resolution (community denied / pro allowed). Real Postgres required.
import { describe, expect, it, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { hasFeature, invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { appendEvent } from "@/server/engine-db";
import { readAuditLedger } from "../fixtures";
import { msgFor } from "@/lib/messages-i18n";

import { setOrgPlan } from "@/lib/__tests__/_billing-group";
const HAS_DB = !!process.env.DATABASE_URL;

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

async function seedFixture(plan: "community" | "pro") {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Au " + suffix}, ${"au-" + suffix})
    returning id`;
  await setOrgPlan(orgId, plan);
  await invalidateOrgEntitlements(orgId);
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  const [{ id: competitionId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility)
    values (${orgId}, ${"C " + suffix}, ${"c-" + suffix}, 'private') returning id`;
  const [{ id: divisionId }] = await sql<{ id: string }[]>`
    insert into divisions (competition_id, name, slug, sport_key, variant_key, config, module_version)
    values (${competitionId}, 'Div', ${"d-" + suffix}, 'generic', 'std',
            ${sql.json(GENERIC_CONFIG)}, '1.0.0') returning id`;
  const [{ id: stageId }] = await sql<{ id: string }[]>`
    insert into stages (division_id, seq, kind, name) values (${divisionId}, 1, 'league', 'L')
    returning id`;
  const [{ id: home }] = await sql<{ id: string }[]>`
    insert into entrants (division_id, kind, display_name, seed)
    values (${divisionId}, 'individual', 'Home', 1) returning id`;
  const [{ id: away }] = await sql<{ id: string }[]>`
    insert into entrants (division_id, kind, display_name, seed)
    values (${divisionId}, 'individual', 'Away', 2) returning id`;
  const [{ id: fixtureId }] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, round_no, seq_in_round, home_entrant_id, away_entrant_id)
    values (${stageId}, ${divisionId}, 1, 1, ${home}, ${away}) returning id`;
  const auth: AuthCtx = {
    orgId,
    via: "session",
    userId: null,
    role: "owner",
    keyId: null,
  };
  return { auth, orgId, competitionId, fixtureId };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("audit ledger (PROMPT-63)", () => {
  it("returns the full hash-chained stream, verified, with the head hash", async () => {
    const { auth, fixtureId } = await seedFixture("pro");
    await appendEvent(auth.orgId, fixtureId, 0, {
      type: "core.start",
      payload: {},
    });
    await appendEvent(auth.orgId, fixtureId, 1, {
      type: "generic.result",
      payload: { p1Score: 2, p2Score: 1 },
    });
    const ledger = await readAuditLedger(auth, fixtureId);
    expect(ledger.events).toHaveLength(2);
    expect(ledger.events[0]!.prev_hash).toBeNull();
    expect(ledger.events[1]!.prev_hash).toBe(ledger.events[0]!.row_hash);
    expect(ledger.head_hash).toBe(ledger.events[1]!.row_hash);
    expect(ledger.verified).toBe(true);
    expect(ledger.first_tampered_seq).toBeNull();
    expect(ledger.fixture).toMatchObject({ home: "Home", away: "Away" });
    expect(ledger.canonical_spec).toContain("sha256");
  });

  it("localises a tampered row (direct DB mutation bypassing the append path)", async () => {
    const { auth, fixtureId } = await seedFixture("pro");
    await appendEvent(auth.orgId, fixtureId, 0, {
      type: "core.start",
      payload: {},
    });
    await appendEvent(auth.orgId, fixtureId, 1, {
      type: "generic.result",
      payload: { p1Score: 1, p2Score: 0 },
    });
    await sql`
      update score_events set payload = ${sql.json({ tampered: true })}
      where fixture_id = ${fixtureId} and seq = 1`;
    const ledger = await readAuditLedger(auth, fixtureId);
    expect(ledger.verified).toBe(false);
    expect(ledger.first_tampered_seq).toBe(1);
    // Clean up the deliberately-corrupt ledger (shared-test-DB hygiene).
    await sql`delete from fixtures where id = ${fixtureId}`;
  });

  it("scoring.audit_export resolves community=false, pro=true (V288 rows)", async () => {
    const community = await seedFixture("community");
    const pro = await seedFixture("pro");
    expect(await hasFeature(community.orgId, "scoring.audit_export")).toBe(false);
    expect(await hasFeature(pro.orgId, "scoring.audit_export")).toBe(true);
  });
});

describe.skipIf(!HAS_DB)("audit PDF (PROMPT-63 §2)", () => {
  it("renders a real PDF for a scored fixture (verdict + events in the model)", async () => {
    const { auth, fixtureId } = await seedFixture("pro");
    await appendEvent(auth.orgId, fixtureId, 0, {
      type: "core.start",
      payload: {},
    });
    await appendEvent(auth.orgId, fixtureId, 1, {
      type: "generic.result",
      payload: { p1Score: 3, p2Score: 2 },
    });
    const { auditLedgerDoc } = await import("../exports");
    const { docModelToPdf } = await import("@/server/doc-render");
    const ledger = await readAuditLedger(auth, fixtureId);
    const model = await auditLedgerDoc(
      auth,
      fixtureId,
      ledger,
      { key_id: "k1", issued_at: "2026-07-18T12:00:00Z" },
      { printedAt: "2026-07-18T12:00:00Z" },
    );
    expect(model.kind).toBe("audit");
    expect(model.description).toContain("VERIFIED ✓");
    expect(model.sections[0]!.table!.rows).toHaveLength(2);
    const bytes = await docModelToPdf(model);
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(bytes.length).toBeGreaterThan(1024);
  });

  // Repair pass (review of F5 remainder): the title's home/away separator was
  // a hardcoded ` vs ` template-literal (exports.ts's auditLedgerDoc), the
  // one export-value site the original F5 remainder pass missed entirely —
  // this doc had no test at all before the line above. Same seam every other
  // export kind already resolves through (`schedule.vs`, exportChrome()).
  it("a French-locale org's title separator comes from the org locale, not a hardcoded ' vs '", async () => {
    const { auth, fixtureId, orgId } = await seedFixture("pro");
    await sql`update organizations set default_locale = 'fr' where id = ${orgId}`;
    await appendEvent(auth.orgId, fixtureId, 0, { type: "core.start", payload: {} });
    await appendEvent(auth.orgId, fixtureId, 1, {
      type: "generic.result",
      payload: { p1Score: 1, p2Score: 0 },
    });
    const { auditLedgerDoc } = await import("../exports");
    const ledger = await readAuditLedger(auth, fixtureId);
    const model = await auditLedgerDoc(auth, fixtureId, ledger, null, {
      printedAt: "2026-07-18T12:00:00Z",
    });
    expect(model.title).toContain(`Home ${msgFor("fr", "schedule.vs")} Away`);
    expect(model.title).not.toContain("Home vs Away");
  });

  // Repair pass (review of F5 remainder, round 2): the header comment above
  // auditLedgerDoc's `vs` block claimed "both sides are always filled
  // entrants. A placeholder cannot reach this doc" -- false. home_entrant_id/
  // away_entrant_id are independently nullable, readAuditLedger never selects
  // a slot-label fallback for the null side (fixtures.ts), and the route
  // applies no fixture-status gate ("In-play fixtures export too"). The
  // routine state of a later bracket round whose sibling parent hasn't
  // finished yet reaches this title with exactly one side null -- and the
  // other test above only ever seeds a fully two-sided fixture, so it never
  // exercised this branch.
  it("a fixture with only one entrant known localizes the missing side, not a hardcoded 'TBD'", async () => {
    const { auth, fixtureId, orgId } = await seedFixture("pro");
    await sql`update organizations set default_locale = 'fr' where id = ${orgId}`;
    await sql`update fixtures set away_entrant_id = null where id = ${fixtureId}`;
    const { auditLedgerDoc } = await import("../exports");
    const ledger = await readAuditLedger(auth, fixtureId);
    expect(ledger.fixture).toMatchObject({ home: "Home", away: null });
    const model = await auditLedgerDoc(auth, fixtureId, ledger, null, {
      printedAt: "2026-07-18T12:00:00Z",
    });
    expect(model.title).toContain(
      `Home ${msgFor("fr", "schedule.vs")} ${msgFor("fr", "bracket.tbd")}`,
    );
    expect(model.title).not.toContain("TBD");
  });
});
