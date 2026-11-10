// W4 app PR B, B3 fix round 1 (review I3): a `firstLosses` take from a double-elimination source is refused by name AT SAVE, through
// the real stage routes (POST create, PUT replace: body parse, authz, the v1 error envelope) on a real Postgres, and a stored row that
// predates the refusal never takes the division page down: the plate card loader (`plateCardStatesFor`, the page's own) answers
// `refused`. Skipped without DATABASE_URL.
import { afterAll, describe, expect, it, vi } from "vitest";

const HAS_DB = !!process.env.DATABASE_URL;

const authState = vi.hoisted(() => ({ userId: "" }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireUser: async () => ({ id: authState.userId }), getCurrentUser: async () => ({ id: authState.userId }), getActiveOrgId: async () => null };
});
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));
vi.mock("@/lib/stripe", async (io) => ({ ...(await io<typeof import("@/lib/stripe")>()), getStripe: vi.fn(() => { throw new Error("no Stripe"); }) }));
vi.mock("@/server/email-outbox/transport", () => ({ deliver: vi.fn() }));

import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { startDivision } from "@/server/usecases/schedule";
import { plateCardStatesFor } from "@/server/usecases/plate-field";
import { asOwner, seedOrg } from "@/server/usecases/__tests__/_registration-fixtures";
import { entrantInput, FOOTBALL, FOOTBALL_KIND } from "@/server/usecases/__tests__/_plate-rig";
import { POST as postStagesRoute, PUT as putStagesRoute } from "@/app/api/v1/divisions/[id]/stages/route";

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (method: string, path: string, body: unknown) =>
  new Request(`https://test.local/api/v1${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
interface Envelope { ok: boolean; error?: { code: string; message: string } }
const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Envelope });

const PLATE = { sources: [{ stage: "previous", take: [{ kind: "firstLosses" }] }], placement: "rank_order", timing: "setup" };

async function division(): Promise<{ owner: AuthCtx; divisionId: string }> {
  const { orgId, ownerId } = await seedOrg("pro");
  authState.userId = ownerId;
  const owner = asOwner(orgId, ownerId);
  const comp = await createCompetition(owner, { ends_on: "2030-12-31", name: "DE plate " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const d = await createDivision(owner, comp.id, { name: "Open", slug: "open-" + randomUUID().slice(0, 6), sport_key: FOOTBALL.key, variant_key: FOOTBALL.variant, config: {} } as never);
  return { owner, divisionId: d.id };
}
const stagesOf = (divisionId: string) => sql<{ id: string; division_id: string; seq: number; kind: string; status: string; progression: unknown }[]>`
  select id, division_id, seq, kind, status, progression from stages where division_id = ${divisionId} order by seq`;

describe.skipIf(!HAS_DB)("a first-loss plate fed by a double-elimination stage (review I3)", () => {
  it("POST refuses it by name (422 SEEDING_FIRSTLOSSES_DE_SOURCE), nothing is written, and a second POST says the same", async () => {
    const { divisionId } = await division();
    const de = await read(await postStagesRoute(req("POST", `/divisions/${divisionId}/stages`, { seq: 1, kind: "double_elim", name: "Main", config: {} }), ctx(divisionId)));
    expect(de.status, "premise: the double-elimination stage itself saves").toBe(201);
    for (const attempt of [1, 2]) {
      const res = await read(await postStagesRoute(req("POST", `/divisions/${divisionId}/stages`, { seq: 2, kind: "knockout", name: "Plate", config: {}, progression: PLATE }), ctx(divisionId)));
      expect([res.status, res.body.error?.code], `attempt ${attempt}`).toEqual([422, "SEEDING_FIRSTLOSSES_DE_SOURCE"]);
      expect((await stagesOf(divisionId)).map((s) => s.kind), `attempt ${attempt}: nothing written`).toEqual(["double_elim"]);
    }
  }, 120_000);

  it("PUT (replace) refuses the same batch WHOLE; the plate behind a single-elimination knockout is taken", async () => {
    const { divisionId } = await division();
    const de = { seq: 1, kind: "double_elim", name: "Main", config: {} };
    const plate = { seq: 2, kind: "knockout", name: "Plate", config: {}, progression: PLATE };
    const refused = await read(await putStagesRoute(req("PUT", `/divisions/${divisionId}/stages`, [de, plate]), ctx(divisionId)));
    expect([refused.status, refused.body.error?.code]).toEqual([422, "SEEDING_FIRSTLOSSES_DE_SOURCE"]);
    expect(await stagesOf(divisionId), "refused whole: nothing written").toEqual([]);
    const ok = await read(await putStagesRoute(req("PUT", `/divisions/${divisionId}/stages`, [{ ...de, kind: "knockout" }, plate]), ctx(divisionId)));
    expect(ok.status, "the same plate behind a single-elimination knockout is taken").toBe(200);
    expect((await stagesOf(divisionId)).map((s) => s.kind)).toEqual(["knockout", "knockout"]);
  }, 120_000);

  it("a STORED row that predates the refusal: the page's plate-card loader answers `refused` and does not throw once the lanes are drawn", async () => {
    const { owner, divisionId } = await division();
    expect((await read(await postStagesRoute(req("POST", `/divisions/${divisionId}/stages`, { seq: 1, kind: "double_elim", name: "Main", config: {} }), ctx(divisionId)))).status).toBe(201);
    expect((await read(await postStagesRoute(req("POST", `/divisions/${divisionId}/stages`, { seq: 2, kind: "knockout", name: "Plate", config: {}, progression: { ...PLATE, sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }] } }), ctx(divisionId)))).status).toBe(201);
    await createEntrants(owner, divisionId, Array.from({ length: 4 }, (_, i) => entrantInput(FOOTBALL_KIND, `P${i + 1}`, i + 1)));
    await startDivision(owner, divisionId);
    const [lines] = await sql<{ n: number }[]>`select count(*)::int as n from fixtures f join stages s on s.id = f.stage_id where s.division_id = ${divisionId} and s.kind = 'double_elim'`;
    expect(lines!.n, "premise: the lane bracket is drawn (the engine would throw over its rows)").toBeGreaterThan(0);
    // The stored row, as a legacy save (before the refusal) would have left it.
    await sql`update stages set progression = ${sql.json(PLATE as never)} where division_id = ${divisionId} and seq = 2`;
    const stages = await stagesOf(divisionId);
    const seeding = stages.filter((s) => (s.progression as { timing?: string } | null)?.timing === "setup");
    expect(seeding, "premise: the plate is the one setup stage").toHaveLength(1);
    const states = await plateCardStatesFor(owner, stages, seeding, [false]);
    expect(states, "the card shows the refusal state").toEqual([{ state: "refused" }]);
  }, 180_000);
});
