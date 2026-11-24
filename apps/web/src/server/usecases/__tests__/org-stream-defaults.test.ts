// Seazn-hosted video, Phase 4 Task 38 (V558): the club defaults' usecase — read and save — on the real table. The route's envelope
// (doors, 400s, the paused seat) is the route test's, the chain a session copies is stream-club-style.test.ts's; this file owns the
// write itself: a field the body leaves out is left alone UNDER CONCURRENCY (one statement, no read-modify-write), a refused template
// writes nothing, another org's id is the 404, and a second save of the same body is the same answer at a higher revision.
//
// Sport-agnostic on purpose (TEST-STRATEGY rule 6): the defaults hold no sport.
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { orgStreamDefaultsOf, saveOrgStreamDefaults } from "../org-stream-defaults";
import { seedOrg } from "./_rig";

const HAS_DB = !!process.env.DATABASE_URL;
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("orgStreamDefaultsOf / saveOrgStreamDefaults", () => {
  it("an org with no row reads nothing set, with a null revision; the first save makes the row at revision 1; a second save of the same body is the same values at revision 2", async () => {
    const { auth } = await seedOrg();
    expect(await orgStreamDefaultsOf(auth.orgId)).toEqual({ overlayTemplate: null, overlayDelayMs: null, revision: null });
    const first = await saveOrgStreamDefaults(auth, auth.orgId, { overlayTemplate: "bar", overlayDelayMs: 4500 });
    expect(first).toEqual({ overlayTemplate: "bar", overlayDelayMs: 4500, revision: 1 });
    const second = await saveOrgStreamDefaults(auth, auth.orgId, { overlayTemplate: "bar", overlayDelayMs: 4500 });
    expect(second).toEqual({ overlayTemplate: "bar", overlayDelayMs: 4500, revision: 2 });
    expect(await orgStreamDefaultsOf(auth.orgId)).toEqual(second);
  });

  it("a clear is a SAVE of null, not a delete: the row stays, both fields null, the revision still rising — and a field left out is left alone", async () => {
    const { auth } = await seedOrg();
    await saveOrgStreamDefaults(auth, auth.orgId, { overlayTemplate: "bug", overlayDelayMs: 0 });
    expect(await saveOrgStreamDefaults(auth, auth.orgId, { overlayTemplate: null }), "only the style named").toEqual({ overlayTemplate: null, overlayDelayMs: 0, revision: 2 });
    expect(await saveOrgStreamDefaults(auth, auth.orgId, { overlayDelayMs: null }), "only the timing named").toEqual({ overlayTemplate: null, overlayDelayMs: null, revision: 3 });
    expect((await sql`select 1 from org_stream_defaults where org_id = ${auth.orgId}`).length, "one row").toBe(1);
  });

  it("two saves of DIFFERENT fields racing on a fresh org both land (one statement per save: the conflict path merges, it never overwrites the other's field)", async () => {
    let checked = 0;
    for (let i = 0; i < 6; i++) {
      const { auth } = await seedOrg();
      await Promise.all([
        saveOrgStreamDefaults(auth, auth.orgId, { overlayTemplate: "bar" }),
        saveOrgStreamDefaults(auth, auth.orgId, { overlayDelayMs: 4500 }),
      ]);
      expect(await orgStreamDefaultsOf(auth.orgId), `round ${i}`).toEqual({ overlayTemplate: "bar", overlayDelayMs: 4500, revision: 2 });
      checked++;
    }
    expect(checked).toBe(6);
  });

  it("a template the registry does not serve is a 400 and writes nothing — not even the timing the same body names; an unknown id after a good save leaves the good one", async () => {
    const { auth } = await seedOrg();
    for (const bad of ["no-such-template", "toString", "__proto__"]) {
      const refused = await saveOrgStreamDefaults(auth, auth.orgId, { overlayTemplate: bad, overlayDelayMs: 4500 }).then(() => null, (e: unknown) => e);
      expect(refused, bad).toBeInstanceOf(HttpError);
      expect((refused as HttpError).status, bad).toBe(400);
    }
    expect((await sql`select 1 from org_stream_defaults where org_id = ${auth.orgId}`).length, "nothing written").toBe(0);
    await saveOrgStreamDefaults(auth, auth.orgId, { overlayTemplate: "bar" });
    await saveOrgStreamDefaults(auth, auth.orgId, { overlayTemplate: "nope" }).catch(() => undefined);
    expect((await orgStreamDefaultsOf(auth.orgId)).overlayTemplate).toBe("bar");
  });

  it("another org's id is the 404 (the caller's own org is authorised, never another's) and writes nothing to either org", async () => {
    const a = await seedOrg();
    const b = await seedOrg();
    const refused = await saveOrgStreamDefaults(a.auth, b.auth.orgId, { overlayTemplate: "bar" }).then(() => null, (e: unknown) => e);
    expect(refused).toBeInstanceOf(HttpError);
    expect((refused as HttpError).status).toBe(404);
    expect((await sql`select 1 from org_stream_defaults where org_id in ${sql([a.auth.orgId, b.auth.orgId])}`).length).toBe(0);
  });

  it("records who saved: updated_by is the saver's user id (an audit stamp, never read back)", async () => {
    const { auth } = await seedOrg();
    const who = "00000000-0000-4000-8000-0000000000a1";
    await saveOrgStreamDefaults({ ...auth, userId: who }, auth.orgId, { overlayDelayMs: 1000 });
    const [row] = await sql<{ updated_by: string | null }[]>`select updated_by from org_stream_defaults where org_id = ${auth.orgId}`;
    expect(row!.updated_by).toBe(who);
  });
});
