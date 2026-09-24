// Scorer sheets carry (Task 6): `/state`'s ETag was the ledger seq alone, so a
// change to the body that appends NO event — a status flip, an outcome, a
// re-folded summary — revalidated to `304` and the browser kept serving the
// stale body. The pad's re-read (`resync`, `handlePadEvents`) goes through the
// browser's HTTP cache, so a match finalised or cancelled with no new event
// stayed "in play" on the phone. The ETag is now derived from the body the
// route serves, so it moves whenever anything the client can read moves.
//
// Driven through the REAL handler with a REAL device-link bearer (the door the
// scan page's pad uses). Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";
import { createDeviceLink } from "@/server/usecases/device-links";
import { fixtureStateEtag, type FixtureStateOut } from "@/server/usecases/fixtures";
import { seedOrg } from "@/server/usecases/__tests__/_seed";
import { fixturesOf, seedStage } from "@/server/usecases/__tests__/_sheets-rig";
import { GET } from "../route";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(() => {
  // The rig stubs DEVICE_LINK_KEK once at import (see its CALLERS note).
  vi.unstubAllEnvs();
});

async function scorableFixture(): Promise<{ fixtureId: string; secret: string }> {
  const { auth } = await seedOrg();
  const { stage } = await seedStage(auth, "league", ["Ada", "Bea"]);
  const [f] = await fixturesOf(stage.id);
  const link = await createDeviceLink(auth, f!.id, null);
  return { fixtureId: f!.id, secret: link.secret };
}

async function getState(
  fixtureId: string,
  secret: string,
  ifNoneMatch?: string,
): Promise<{ status: number; etag: string | null; body: { data?: FixtureStateOut } | null }> {
  const headers: Record<string, string> = { authorization: `Bearer ${secret}` };
  if (ifNoneMatch) headers["if-none-match"] = ifNoneMatch;
  const res = await GET(new Request(`https://test.local/api/v1/fixtures/${fixtureId}/state`, { headers }), {
    params: Promise.resolve({ id: fixtureId }),
  });
  const text = await res.text();
  return {
    status: res.status,
    etag: res.headers.get("etag"),
    body: text ? (JSON.parse(text) as { data?: FixtureStateOut }) : null,
  };
}

describe("fixtureStateEtag — derived from the body, not a hand list", () => {
  const body: FixtureStateOut = {
    fixture_id: "f-1",
    status: "in_play",
    last_seq: 3,
    summary: { headline: "2–1" },
    state: { phase: "live", score: [2, 1] },
    outcome: null,
  };

  it("is a quoted strong validator, and equal bodies share it", () => {
    expect(fixtureStateEtag(body)).toMatch(/^"[^"]+"$/);
    expect(fixtureStateEtag({ ...body })).toBe(fixtureStateEtag(body));
  });

  // Every field the route serves, enumerated from the body itself — a field
  // added to FixtureStateOut joins this sweep without anyone listing it.
  it.each(Object.keys(body) as (keyof FixtureStateOut)[])("changes when %s changes, with the seq held", (key) => {
    const moved = { ...body, [key]: key === "last_seq" ? 4 : { moved: key } } as FixtureStateOut;
    expect(moved.last_seq === body.last_seq || key === "last_seq").toBe(true);
    expect(fixtureStateEtag(moved)).not.toBe(fixtureStateEtag(body));
  });
});

describe.skipIf(!HAS_DB)("GET /api/v1/fixtures/{id}/state — revalidation", () => {
  it("an unchanged body revalidates to 304 (the positive pair)", async () => {
    const { fixtureId, secret } = await scorableFixture();
    const first = await getState(fixtureId, secret);
    expect(first.status).toBe(200);
    expect(first.etag).toBeTruthy();
    const again = await getState(fixtureId, secret, first.etag!);
    expect(again.status).toBe(304);
    expect(again.etag).toBe(first.etag);
  });

  it("a status change with NO new event is a new ETag: the old one gets 200 and the new status", async () => {
    const { fixtureId, secret } = await scorableFixture();
    const before = await getState(fixtureId, secret);
    expect(before.status).toBe(200);
    expect(before.body?.data?.status).toBe("scheduled");
    const seqBefore = before.body?.data?.last_seq;

    // No organiser action changes status without appending an event, so the
    // flip is SQL: it moves exactly one body field and leaves the ledger alone
    // — which is the case a seq-only ETag could not see.
    await sql`update fixtures set status = 'cancelled' where id = ${fixtureId}`;

    const after = await getState(fixtureId, secret, before.etag!);
    expect(after.status, "the stale validator must not be honoured").toBe(200);
    expect(after.body?.data?.status).toBe("cancelled");
    expect(after.body?.data?.last_seq, "no event was appended").toBe(seqBefore);
    expect(after.etag).not.toBe(before.etag);
  });
});
