// Sponsor deals batch J review m3: a sponsor's name is TRIMMED at every write, and a blank name is refused. The create's
// `name` was `z.string().min(1)` with no trim, so the v1 API (and anything that is not the sponsor form, which trims in the
// browser) accepted "   " and saved a sponsor whose name is three spaces: a card with no words on it, a list row nobody can
// find, an invoice addressed to nobody. Pre-existing, found by the batch J review.
//
// Two layers, both pinned: the SCHEMAS (the usecase's runtime parse and the OpenAPI document's twin, create and patch, no
// DB), and the REAL create and patch routes over the real tables (the producer a client actually calls).
//
// Expected values come from the rule (a name is its words, 1..80 characters, no edge whitespace), never from the schema's own
// output. Sport-agnostic on purpose (TEST-STRATEGY rule 6): a sponsor's name reads no sport.
import { afterAll, describe, expect, it, vi } from "vitest";

const authState = vi.hoisted(() => ({ userId: "" }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireUser: async () => ({ id: authState.userId }),
    getCurrentUser: async () => ({ id: authState.userId }),
    getActiveOrgId: async () => null,
  };
});
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

import { sql } from "@/lib/db";
import { CreateSponsor, PatchSponsor } from "@/server/api-v1/schemas";
import { CreateSponsorInput, PatchSponsorInput } from "@/server/usecases/sponsors";
import { seedOrg } from "@/server/usecases/__tests__/_seed";
import { POST as createRoute } from "../route";
import { PATCH } from "../[sponsorId]/route";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

/** A non-breaking space, built from its code point so no editor or tool can normalise it to a plain space and leave the list claiming
 *  a character it does not hold (the file is checked for the real thing below). */
const NBSP = String.fromCharCode(0xa0);

/** What a "blank" name looks like to a person: nothing, spaces, a tab, a newline, a non-breaking space (alone, doubled, between spaces). */
const BLANK = ["", " ", "   ", "\t", "\n", " \t \n ", NBSP, NBSP + NBSP, ` ${NBSP} `];

const SCHEMAS = [
  ["usecase CreateSponsorInput (the v1 runtime parse)", CreateSponsorInput],
  ["usecase PatchSponsorInput (the v1 runtime parse)", PatchSponsorInput],
  ["api-v1 CreateSponsor (OpenAPI)", CreateSponsor],
  ["api-v1 PatchSponsor (OpenAPI)", PatchSponsor],
] as const;

describe("sponsor name: trimmed and never blank - the schemas (no DB)", () => {
  it("premise: the blank list really holds a non-breaking space (code point 160), and a plain space is not one", () => {
    expect(NBSP.charCodeAt(0)).toBe(160);
    expect(NBSP).not.toBe(" ");
    expect(BLANK.filter((b) => b.includes(NBSP)).length, "three of the blanks carry it").toBe(3);
    expect(new Set(BLANK).size, "no blank is listed twice").toBe(BLANK.length);
  });

  it("every write schema refuses a blank name, on the `name` field (count reported)", () => {
    let checked = 0;
    for (const [schemaName, schema] of SCHEMAS) {
      for (const name of BLANK) {
        const res = schema.safeParse({ name });
        expect(res.success, `${schemaName}: ${JSON.stringify(name)}`).toBe(false);
        expect(res.error!.issues.map((i) => i.path.join(".")), `${schemaName}: ${JSON.stringify(name)}`).toContain("name");
        checked++;
      }
    }
    expect(checked).toBe(SCHEMAS.length * BLANK.length);
  });

  it("positive pair: a name keeps its words and loses its edge whitespace; inner spaces stay (count reported)", () => {
    let checked = 0;
    for (const [schemaName, schema] of SCHEMAS) {
      expect(schema.parse({ name: "  Harbour Physio  " }).name, schemaName).toBe("Harbour Physio");
      expect(schema.parse({ name: "\n\tHarbour  Physio\t" }).name, `${schemaName}: inner double space is the sponsor's own`).toBe("Harbour  Physio");
      expect(schema.parse({ name: "Harbour Physio" }).name, `${schemaName}: an already-clean name is untouched`).toBe("Harbour Physio");
      expect(schema.parse({ name: `${NBSP}Harbour Physio${NBSP}` }).name, `${schemaName}: a non-breaking space at the edge is trimmed too`).toBe("Harbour Physio");
      checked += 4;
    }
    expect(checked).toBe(SCHEMAS.length * 4);
  });

  it("the 80-character limit counts the TRIMMED name: 80 words-characters padded with spaces saves, 81 does not", () => {
    let checked = 0;
    const eighty = "x".repeat(80);
    for (const [schemaName, schema] of SCHEMAS) {
      expect(schema.safeParse({ name: `  ${eighty}  ` }).success, `${schemaName}: padded 80`).toBe(true);
      expect(schema.safeParse({ name: `${eighty}x` }).success, `${schemaName}: 81`).toBe(false);
      checked += 2;
    }
    expect(checked).toBe(SCHEMAS.length * 2);
  });

  it("a patch that does not name `name` stays without one (the trim must not invent a field)", () => {
    for (const [schemaName, schema] of [["usecase PatchSponsorInput", PatchSponsorInput], ["api-v1 PatchSponsor", PatchSponsor]] as const) {
      expect(schema.parse({ on_stream: true }), schemaName).toEqual({ on_stream: true });
    }
  });
});

type Envelope = { ok: boolean; data?: { id: string; name: string }; error?: { code: string; message: string } };
const base = (orgId: string) => `http://localhost/api/v1/orgs/${orgId}/sponsors`;
const json = (method: string, body: unknown) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const create = (orgId: string, body: unknown) => createRoute(new Request(base(orgId), json("POST", body)), { params: Promise.resolve({ id: orgId }) });
const patch = (orgId: string, sponsorId: string, body: unknown) =>
  PATCH(new Request(`${base(orgId)}/${sponsorId}`, json("PATCH", body)), { params: Promise.resolve({ id: orgId, sponsorId }) });
const nameOf = async (id: string): Promise<string> => (await sql<{ name: string }[]>`select name from sponsors where id = ${id}`)[0]!.name;
const countOf = async (orgId: string): Promise<number> =>
  (await sql<{ n: number }[]>`select count(*)::int as n from sponsors where org_id = ${orgId}`)[0]!.n;

describe.skipIf(!HAS_DB)("sponsor name: trimmed and never blank - over the real routes", () => {
  it("POST: every blank name is a 400 and saves NOTHING; a padded name saves trimmed (count reported)", async () => {
    const { auth } = await seedOrg("pro");
    authState.userId = auth.userId!;
    let checked = 0;
    for (const name of BLANK) {
      const res = await create(auth.orgId, { name });
      expect(res.status, JSON.stringify(name)).toBe(400);
      checked++;
    }
    expect(checked, "anti-vacuity").toBe(BLANK.length);
    expect(await countOf(auth.orgId), "no blank sponsor was written").toBe(0);

    // Edge whitespace of every kind the person might paste: spaces and a non-breaking space.
    const ok = await create(auth.orgId, { name: `   ${NBSP}Harbour Physio ${NBSP} ` });
    expect(ok.status).toBe(201);
    const made = ((await ok.json()) as Envelope).data!;
    expect(made.name, "the answer").toBe("Harbour Physio");
    expect(await nameOf(made.id), "the row").toBe("Harbour Physio");
    expect(await countOf(auth.orgId)).toBe(1);
  });

  it("PATCH: a blank name is a 400 and the name is NOT overwritten; a padded rename saves trimmed; a second rename still works (sequence)", async () => {
    const { auth } = await seedOrg("pro");
    authState.userId = auth.userId!;
    const made = ((await (await create(auth.orgId, { name: "Harbour Physio" })).json()) as Envelope).data!;

    let checked = 0;
    for (const name of BLANK) {
      const res = await patch(auth.orgId, made.id, { name });
      expect(res.status, JSON.stringify(name)).toBe(400);
      expect(await nameOf(made.id), `after ${JSON.stringify(name)}`).toBe("Harbour Physio");
      checked++;
    }
    expect(checked, "anti-vacuity").toBe(BLANK.length);

    const renamed = await patch(auth.orgId, made.id, { name: "  Quay Dental \n" });
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as Envelope).data!.name, "the answer").toBe("Quay Dental");
    expect(await nameOf(made.id), "the row").toBe("Quay Dental");

    const again = await patch(auth.orgId, made.id, { name: "Quay Dental & Co" });
    expect(again.status).toBe(200);
    expect(await nameOf(made.id)).toBe("Quay Dental & Co");
  });
});
