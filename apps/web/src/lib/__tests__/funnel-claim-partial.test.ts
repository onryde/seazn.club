// A claim that fails half-way (start-wizard redesign T2 review m1). The claim is not one transaction — each use-case
// opens its own — so it reads and checks what it can BEFORE the competition exists (the pre-flight; the quota and the
// stage kinds' plan features are the use-cases' own), and a write refused after that is logged by step
// (`funnel_claim_build_partial`, with the refusal's status) and rethrown as a FunnelClaimPartialError around the
// use-case's own refusal — the route tells a part-built event from an unbuilt one by it. The token is spent and a 4xx is
// logged by nobody else.
//
// Driven through the real claim path on a real database. Stand-ins: each later use-case is the real one, wrapped so a
// test can make exactly one of them refuse; and the format layer's graph, which one case swaps for a graph the API
// refuses (no shipped graph is refused: every funnel graph parses).
// Real Postgres required — skipped without DATABASE_URL (test-infra recipe).
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const rig = vi.hoisted(() => ({
  failAt: null as string | null,
  badGraph: false,
  // Each step refuses with its own status (the division with a bare throw: none), so the log's `status` is read per step.
  statusOf: { division: null, stages: 409, entrants: 402, venue: 503 } as Record<string, number | null>,
}));
async function refusal(step: string): Promise<Error> {
  const status = rig.statusOf[step];
  if (status == null) return new Error("forced refusal (test)");
  const { HttpError } = await import("@/lib/errors");
  return new HttpError(status, "forced refusal (test)");
}

vi.mock("@/server/usecases/divisions", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/usecases/divisions")>();
  return { ...real, createDivision: (async (...a: Parameters<typeof real.createDivision>) => {
    if (rig.failAt === "division") throw await refusal("division");
    return real.createDivision(...a);
  }) as typeof real.createDivision };
});
vi.mock("@/server/usecases/stages", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/usecases/stages")>();
  return { ...real, createStages: (async (...a: Parameters<typeof real.createStages>) => {
    if (rig.failAt === "stages") throw await refusal("stages");
    return real.createStages(...a);
  }) as typeof real.createStages };
});
vi.mock("@/server/usecases/entrants", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/usecases/entrants")>();
  return { ...real, createEntrants: (async (...a: Parameters<typeof real.createEntrants>) => {
    if (rig.failAt === "entrants") throw await refusal("entrants");
    return real.createEntrants(...a);
  }) as typeof real.createEntrants };
});
vi.mock("@/server/usecases/venues", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/usecases/venues")>();
  // The court write, not the venue's: a refusal in the middle of the step still names it.
  return { ...real, createCourt: (async (...a: Parameters<typeof real.createCourt>) => {
    if (rig.failAt === "venue") throw await refusal("venue");
    return real.createCourt(...a);
  }) as typeof real.createCourt };
});
vi.mock("@/lib/funnel-formats", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/funnel-formats")>();
  return { ...real, funnelFormatStages: ((...a: Parameters<typeof real.funnelFormatStages>) => {
    const drafts = real.funnelFormatStages(...a);
    return rig.badGraph ? drafts.map((d) => ({ ...d, kind: "not_a_stage_kind" })) : drafts;
  }) as typeof real.funnelFormatStages };
});

import { sql } from "@/lib/db";
import { createOrgForUser } from "@/lib/auth";
import { FunnelClaimPartialError, consumeFunnelDraft, createFromDraft, createFunnelDraft, type FunnelPayload } from "@/lib/funnel";
import { log } from "@/server/logger";

const HAS_DB = !!process.env.DATABASE_URL;
const RUN = `fcp-${randomUUID().slice(0, 8)}`;
const address = (): string => `${RUN}-${randomUUID().slice(0, 8)}@example.com`;

/** A user who already has an organisation, so the claim's first write is the competition. */
async function organiser(): Promise<{ userId: string; orgId: string; email: string }> {
  const email = address();
  const [u] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified) values (${email}, 'Partial Claimant', true) returning id`;
  const org = await createOrgForUser(u!.id, `${RUN} org`);
  return { userId: u!.id, orgId: org.id, email };
}

async function draftFor(email: string, over: Partial<FunnelPayload> = {}) {
  const payload: FunnelPayload = { name: `${RUN} ${randomUUID().slice(0, 6)}`, sport: "Badminton", entrants: 6, format: "league", courts: 2, ...over };
  const { token } = await createFunnelDraft(email, payload, sql, "en");
  const draft = await consumeFunnelDraft(token);
  expect(draft, "claimable").not.toBeNull();
  return { draft: draft!, token, payload };
}

const competitionsOf = (orgId: string) => sql<{ id: string }[]>`select id from competitions where org_id = ${orgId}`;
const partialLogs = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter((c) => c[1] === "funnel_claim_build_partial");

afterEach(() => {
  rig.failAt = null;
  rig.badGraph = false;
  vi.restoreAllMocks();
});
afterAll(async () => {
  if (!HAS_DB) return;
  await sql`delete from funnel_drafts where email like ${`${RUN}-%`}`;
  // The organisers, their organisations and what the claims built (competitions and below cascade with the org).
  const ids = (await sql<{ id: string }[]>`select id from users where email like ${`${RUN}-%`}`).map((u) => u.id);
  // Courts first: their (venue, org) key does not cascade from the venue, so an org delete would trip on it.
  await sql`delete from courts where org_id in (select id from organizations where created_by = any(${ids}::uuid[]))`;
  await sql`delete from organizations where created_by = any(${ids}::uuid[])`;
  await sql`delete from subscriptions where owner_user_id = any(${ids}::uuid[])`;
  await sql`delete from users where id = any(${ids}::uuid[])`;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("a claim refused half-way says which step, and a pre-flight refusal writes nothing (T2 m1)", () => {
  it("a write refused after the competition exists is logged by its step and rethrown; the log carries no address or token", async () => {
    const steps = ["division", "stages", "entrants", "venue"] as const;
    let checked = 0;
    for (const step of steps) {
      const o = await organiser();
      const { draft, token } = await draftFor(o.email);
      const errors = vi.spyOn(log, "error");
      rig.failAt = step;
      const thrown = await createFromDraft(o.userId, draft).then(
        () => null,
        (e: unknown) => e,
      );
      rig.failAt = null;

      const comps = await competitionsOf(o.orgId);
      expect(comps, `${step}: the competition was written before the refusal`).toHaveLength(1);
      // Rethrown as the part-built refusal, around the use-case's own (its message, its status).
      expect(thrown, `${step}: a part-built refusal`).toBeInstanceOf(FunnelClaimPartialError);
      const partial = thrown as FunnelClaimPartialError;
      expect({ step: partial.step, competitionId: partial.competitionId }, step).toEqual({ step, competitionId: comps[0]!.id });
      expect((partial.cause as Error).message, `${step}: the use-case's own refusal`).toBe("forced refusal (test)");
      expect((partial.cause as { status?: number }).status ?? null, `${step}: its status`).toBe(rig.statusOf[step]);
      const logged = partialLogs(errors);
      expect(logged, `${step}: logged once`).toHaveLength(1);
      expect(logged[0]![0], step).toEqual({ step, competitionId: comps[0]!.id, status: rig.statusOf[step] });
      const text = JSON.stringify(logged[0]);
      expect(text, `${step}: no address`).not.toContain(o.email);
      expect(text, `${step}: no token`).not.toContain(token);
      errors.mockRestore();
      checked++;
    }
    expect(checked, "anti-vacuity: every step after the competition was refused once").toBe(steps.length);
    expect(new Set(steps.map((s) => rig.statusOf[s])).size, "premise: every step refuses with its own status").toBe(steps.length);
  });

  it("a claim that builds cleanly logs no partial build", async () => {
    const o = await organiser();
    const { draft } = await draftFor(o.email);
    const errors = vi.spyOn(log, "error");
    await createFromDraft(o.userId, draft);
    expect(partialLogs(errors)).toEqual([]);
    expect(await competitionsOf(o.orgId)).toHaveLength(1);
  });

  it("a stage graph the API refuses is refused in the pre-flight: no competition, no division, no log", async () => {
    const o = await organiser();
    const { draft } = await draftFor(o.email, { format: "knockout" });
    const errors = vi.spyOn(log, "error");
    rig.badGraph = true;
    await expect(createFromDraft(o.userId, draft)).rejects.toMatchObject({ name: "ZodError" });
    expect(await competitionsOf(o.orgId), "nothing of the event was written").toEqual([]);
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from divisions d join competitions c on c.id = d.competition_id where c.org_id = ${o.orgId}`;
    expect(n).toBe(0);
    expect(partialLogs(errors), "nothing to report: nothing was built").toEqual([]);
  });
});
