// Settings C8 seam (owner 2026-11-11): city and country left the competition settings form but must survive its save.
// Two halves make that true — the form never sends them (competition-settings-c8.test.tsx) and the server merges
// `discovery` key by key (competition-discovery-merge.test.ts). Each half is green on its own fixture; this drives the
// REAL island's request through the route's own schema into the real use case, so a drift between the two (the form
// sending a whole `discovery`, the schema stripping a key, the merge reading another shape) reds here.
//
// Real Postgres; skipped without DATABASE_URL.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { PatchCompetition } from "@/server/api-v1/schemas";
import { createCompetition, patchCompetition } from "../competitions";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { expandSettingsCard } from "@/components/v2/__tests__/_settings-card-expand";
import { CompetitionSettings } from "@/components/v2/competition-settings";
import { apiV1 } from "@/lib/client-v1";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
}));
vi.mock("@/lib/client-v1", async () => {
  const actual = await vi.importActual<typeof import("@/lib/client-v1")>("@/lib/client-v1");
  return { ...actual, apiV1: vi.fn() };
});
const api = vi.mocked(apiV1);

const HAS_DB = !!process.env.DATABASE_URL;

async function seedOwner(): Promise<AuthCtx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`seam-${suffix}@test.local`}, 'Owner', true) returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Seam Org " + suffix}, ${"seam-org-" + suffix}, ${userId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, 'owner')`;
  return { orgId, via: "session", userId, role: "owner", keyId: null };
}

const STORED = { city: "Harbour Vale", country: "United Kingdom" };

async function located(owner: AuthCtx) {
  const c = await createCompetition(owner, {
    name: "Winter Open " + randomUUID().slice(0, 6),
    starts_on: "2030-12-01",
    ends_on: "2030-12-31",
    visibility: "public",
    branding: {},
  });
  await sql`update competitions set discovery = ${sql.json(STORED as never)} where id = ${c.id}`;
  const [row] = await sql<{ name: string; discovery: Record<string, string | null> }[]>`
    select name, discovery from competitions where id = ${c.id}`;
  return { id: c.id, name: row!.name, discovery: row!.discovery };
}

/** Rename in the real island, press Save, and hand its request to the route's schema and the use case. */
async function saveThroughIsland(owner: AuthCtx, comp: { id: string; name: string; discovery: Record<string, string | null> }, discoveryBranding: boolean, newName: string) {
  api.mockReset();
  api.mockResolvedValue({} as never);
  const island = renderIsland(
    CompetitionSettings,
    {
      competition: {
        id: comp.id, name: comp.name, slug: "x", description: null, starts_on: "2030-12-01", ends_on: "2030-12-31",
        visibility: "public", status: "draft", frozen: false, discoverable: false, discovery: comp.discovery, branding: {},
      },
      orgId: owner.orgId,
      canEdit: true,
      discoveryBranding,
      viewerPlan: "community",
    },
    expandSettingsCard,
  );
  const name = island.tree().find((el) => el.type === "input" && propsOf(el).maxLength === 200 && propsOf(el).required === true)!;
  (propsOf(name).onChange as (e: { target: { value: string } }) => void)({ target: { value: newName } });
  const form = island.tree().find((el) => el.type === "form")!;
  await (propsOf(form).onSubmit as (e: { preventDefault(): void }) => Promise<void>)({ preventDefault() {} });
  expect(api, "the island sent exactly one request").toHaveBeenCalledTimes(1);
  const [path, init] = api.mock.calls[0]! as [string, { method: string; json: unknown }];
  expect(path).toBe(`/api/v1/competitions/${comp.id}`);
  expect(init.method).toBe("PATCH");
  await patchCompetition(owner, comp.id, PatchCompetition.parse(init.json));
}

const stored = async (id: string) =>
  (await sql<{ name: string; discovery: Record<string, unknown> }[]>`select name, discovery from competitions where id = ${id}`)[0]!;

beforeEach(() => api.mockReset());

afterAll(async () => {
  if (!HAS_DB) return;
  await sql.end();
});

describe.skipIf(!HAS_DB)("competition settings → PATCH schema → patchCompetition: city and country survive the C8 form's save", () => {
  it("premise: the competition really starts with a stored city and country", async () => {
    const owner = await seedOwner();
    const comp = await located(owner);
    expect(comp.discovery).toMatchObject(STORED);
  });

  it("an org without discovery.branding: the save renames and leaves the stored pair alone", async () => {
    const owner = await seedOwner();
    const comp = await located(owner);
    await saveThroughIsland(owner, comp, false, "Winter Open Renamed");
    const row = await stored(comp.id);
    expect(row.name).toBe("Winter Open Renamed");
    expect(row.discovery).toMatchObject(STORED);
  });

  it("an entitled form (it sends the tagline): the stored pair still survives, saved twice", async () => {
    const owner = await seedOwner();
    const comp = await located(owner);
    await saveThroughIsland(owner, comp, true, "Renamed once");
    await saveThroughIsland(owner, { ...comp, name: "Renamed once" }, true, "Renamed twice");
    const row = await stored(comp.id);
    expect(row.name).toBe("Renamed twice");
    expect(row.discovery).toMatchObject(STORED);
    expect(row.discovery).toMatchObject({ tagline: null });
  });
});
