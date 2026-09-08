// Entitlements v18 W4 Task 4, review round 1 — Finding 2: the previous Step 8
// verification of POST_AUTO_DRAFTED drove only the weekly-digest route, and
// the digest is exempt from the `org_posts_auto_once` constraint (V358), so
// it can NEVER reach the `on conflict … do nothing` branch. The guard's
// runtime behaviour in BOTH directions (AGENTS.md class 13 — an idempotency
// guard can also swallow a legitimate new arrival) was never actually driven.
//
// This drives `refreshNews` (the scoring hot-path caller, usecases/scoring.ts
// — review round 1, finding 1 moved the capture here, AFTER the transaction
// it opens commits) through the SAME fixture/round twice, and a genuinely new
// fixture/round once more, with `captureServer` mocked so the call COUNT and
// ARGUMENTS are pinned precisely rather than inferred from a log line. Real
// Postgres required.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { builtinModules } from "@seazn/engine/sports";

import { sql } from "@/lib/db";
import { captureServer } from "@/lib/posthog-server";
import { EVENTS } from "@/lib/analytics-events";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { refreshNews } from "../scoring";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";

vi.mock("@/lib/posthog-server", () => ({ captureServer: vi.fn().mockResolvedValue(undefined) }));

const HAS_DB = !!process.env.DATABASE_URL;
const FOOTBALL_CFG = builtinModules.find((m) => m.key === "football")!.configSchema.parse({});

interface Ctx {
  auth: AuthCtx;
  orgId: string;
  userId: string;
}

interface DivCtx {
  divisionId: string;
  stageId: string;
  entrantA: string;
  entrantB: string;
}

async function seedOrg(): Promise<Ctx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`autodraft-${suffix}@test.local`}, 'AutoDraft', true) returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by, default_locale)
    values (${"AutoDraft " + suffix}, ${"autodraft-" + suffix}, ${userId}, 'en') returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, 'owner')`;
  await setOrgPlan(orgId);
  await invalidateOrgEntitlements(orgId);
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('football', 'Football', '1.0.0', ${sql.json({ groups: [], lineup: { size: 11, benchMax: 12 } })})
    on conflict (key) do nothing`;
  return { auth: { orgId, via: "session", userId, role: "owner", keyId: null }, orgId, userId };
}

async function seedDivision(ctx: Ctx): Promise<DivCtx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility, created_by)
    values (${ctx.orgId}, 'Cup', ${"cup-" + suffix}, 'public', ${ctx.userId}) returning id`;
  const [{ id: divisionId }] = await sql<{ id: string }[]>`
    insert into divisions (competition_id, org_id, name, slug, sport_key, variant_key,
      config, module_version, auto_posts)
    values (${compId}, ${ctx.orgId}, 'Premier', ${"prem-" + suffix}, 'football', '11-a-side',
      ${sql.json(FOOTBALL_CFG as never)}, '1.0.0', true)
    returning id`;
  // 'knockout', not a TABLE_KINDS member (league/group/swiss) — deliberately,
  // so a decided fixture drafts exactly ONE post (result), not a second
  // round_recap. Both directions of the guard are about the RESULT draft;
  // a table-stage recap would double each count and blur the assertions.
  const [{ id: stageId }] = await sql<{ id: string }[]>`
    insert into stages (division_id, org_id, seq, kind, name)
    values (${divisionId}, ${ctx.orgId}, 1, 'knockout', 'Knockout') returning id`;
  const [{ id: entrantA }] = await sql<{ id: string }[]>`
    insert into entrants (division_id, org_id, kind, display_name, seed)
    values (${divisionId}, ${ctx.orgId}, 'team', 'Home', 1) returning id`;
  const [{ id: entrantB }] = await sql<{ id: string }[]>`
    insert into entrants (division_id, org_id, kind, display_name, seed)
    values (${divisionId}, ${ctx.orgId}, 'team', 'Away', 2) returning id`;
  return { divisionId, stageId, entrantA, entrantB };
}

async function seedDecidedFixture(ctx: Ctx, div: DivCtx, round: number): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round,
      home_entrant_id, away_entrant_id, status, outcome)
    values (${div.stageId}, ${div.divisionId}, ${ctx.orgId}, ${round}, 1,
      ${div.entrantA}, ${div.entrantB}, 'decided',
      ${sql.json({ kind: "win", winner: div.entrantA, loser: div.entrantB })})
    returning id`;
  await sql`
    insert into match_states (fixture_id, org_id, last_seq, state, summary)
    values (${id}, ${ctx.orgId}, 1, ${sql.json({})},
      ${sql.json({
        headline: "2–1",
        perSide: [
          { entrantId: div.entrantA, line: "2" },
          { entrantId: div.entrantB, line: "1" },
        ],
      })})
    on conflict (fixture_id) do update set summary = excluded.summary`;
  return id;
}

function autoDraftCalls() {
  return vi
    .mocked(captureServer)
    .mock.calls.map(([args]) => args)
    .filter((c) => c.event === EVENTS.POST_AUTO_DRAFTED);
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("refreshNews -> POST_AUTO_DRAFTED: the once-per-fixture guard, driven for real", () => {
  beforeEach(() => {
    vi.mocked(captureServer).mockClear();
  });

  it("fires once on the real insert, and fires NO second capture on a repeat call for the same decided fixture", async () => {
    const ctx = await seedOrg();
    const div = await seedDivision(ctx);
    const fx = await seedDecidedFixture(ctx, div, 1);

    await refreshNews(ctx.auth, fx);
    expect(autoDraftCalls()).toHaveLength(1);
    expect(autoDraftCalls()[0]).toMatchObject({
      orgId: ctx.orgId,
      distinctId: `org:${ctx.orgId}`,
      properties: { kind: "result", trigger: "fixture_decided" },
    });

    // Same fixture, still decided, nothing voided in between — the auto-once
    // index (V295, org_posts_auto_once) refuses the second insert inside the
    // transaction, and `insertDraft` hands nothing back for it. The guard
    // must not fire a second capture for that no-op.
    await refreshNews(ctx.auth, fx);
    expect(autoDraftCalls()).toHaveLength(1); // still 1 — the repeat fired nothing
  });

  it("a genuinely NEW fixture is never swallowed by the same-fixture guard", async () => {
    const ctx = await seedOrg();
    const div = await seedDivision(ctx);
    const fx1 = await seedDecidedFixture(ctx, div, 1);
    const fx2 = await seedDecidedFixture(ctx, div, 2); // different round → different fixture

    await refreshNews(ctx.auth, fx1);
    await refreshNews(ctx.auth, fx2);

    const calls = autoDraftCalls();
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.properties?.kind === "result")).toBe(true);
  });
});
