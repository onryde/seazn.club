// Activation-funnel event-firing pins for the MANUAL create/patch paths
// (competitions.ts) — closes a P4 review follow-up gap (2026-08-13): when
// finding 1 was fixed, the template path (templates.ts) got an exact-once
// pin on the funnel events, but nothing pinned the call COUNT on the
// ORIGINAL manual paths (createCompetition/patchCompetition) that
// fireCompetitionCreated/fireCompetitionMadePublic were extracted FROM. The
// gap predates this branch, but the extraction makes it newly dangerous — a
// future edit to either shared function can now double-fire or reorder
// relative to the transaction for every caller at once, silently. Real
// Postgres required — org-scoping goes through withTenant/RLS.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { captureServer } from "@/lib/posthog-server";
import { EVENTS } from "@/lib/analytics-events";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition, patchCompetition } from "../competitions";

vi.mock("@/lib/posthog-server", () => ({ captureServer: vi.fn().mockResolvedValue(undefined) }));

const HAS_DB = !!process.env.DATABASE_URL;

async function seedOrg(): Promise<AuthCtx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"ActEvt " + suffix}, ${"actevt-" + suffix})
    returning id`;
  return { orgId, via: "session", userId: null, role: "owner", keyId: null };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("createCompetition / patchCompetition — activation funnel call counts", () => {
  beforeEach(() => {
    vi.mocked(captureServer).mockClear();
  });

  it("a private competition fires COMPETITION_CREATED exactly once and COMPETITION_MADE_PUBLIC never", async () => {
    const auth = await seedOrg();
    await createCompetition(auth, {
      name: `Priv ${randomUUID().slice(0, 6)}`,
      ends_on: "2030-12-31",
      visibility: "private",
      branding: {},
    });
    const calls = vi.mocked(captureServer).mock.calls.map(([args]) => args);
    expect(calls.filter((c) => c.event === EVENTS.COMPETITION_CREATED)).toHaveLength(1);
    expect(calls.filter((c) => c.event === EVENTS.COMPETITION_MADE_PUBLIC)).toHaveLength(0);
  });

  it("a competition created directly public fires BOTH COMPETITION_CREATED and COMPETITION_MADE_PUBLIC, exactly once each", async () => {
    const auth = await seedOrg();
    const comp = await createCompetition(auth, {
      name: `Pub ${randomUUID().slice(0, 6)}`,
      ends_on: "2030-12-31",
      visibility: "public",
      branding: {},
    });
    const calls = vi.mocked(captureServer).mock.calls.map(([args]) => args);
    expect(calls.filter((c) => c.event === EVENTS.COMPETITION_CREATED)).toHaveLength(1);
    const madePublic = calls.filter((c) => c.event === EVENTS.COMPETITION_MADE_PUBLIC);
    expect(madePublic).toHaveLength(1);
    expect(madePublic[0]).toMatchObject({ properties: { competition_id: comp.id } });
  });

  it("patchCompetition transitioning private -> public fires COMPETITION_MADE_PUBLIC exactly once", async () => {
    const auth = await seedOrg();
    const comp = await createCompetition(auth, {
      name: `ToPublic ${randomUUID().slice(0, 6)}`,
      ends_on: "2030-12-31",
      visibility: "private",
      branding: {},
    });
    vi.mocked(captureServer).mockClear(); // isolate the patch from the create's own emissions
    await patchCompetition(auth, comp.id, { visibility: "public" });
    const calls = vi.mocked(captureServer).mock.calls.map(([args]) => args);
    expect(calls.filter((c) => c.event === EVENTS.COMPETITION_MADE_PUBLIC)).toHaveLength(1);
  });

  it("patching an already-public competition on an unrelated field does NOT re-fire COMPETITION_MADE_PUBLIC", async () => {
    const auth = await seedOrg();
    const comp = await createCompetition(auth, {
      name: `StaysPublic ${randomUUID().slice(0, 6)}`,
      ends_on: "2030-12-31",
      visibility: "public",
      branding: {},
    });
    vi.mocked(captureServer).mockClear();
    await patchCompetition(auth, comp.id, { name: `Renamed ${randomUUID().slice(0, 6)}` });
    const calls = vi.mocked(captureServer).mock.calls.map(([args]) => args);
    expect(calls.filter((c) => c.event === EVENTS.COMPETITION_MADE_PUBLIC)).toHaveLength(0);
  });
});
