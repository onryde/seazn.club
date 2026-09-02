// PROMPT-21 acceptance (doc 13 §7): mint/revoke lifecycle, the dl_ auth
// door (fixture-scoped only), device-link scoring with issuer attribution,
// undo-own-only, finalize 403, expiry/revocation → 401 with distinct codes,
// hash-chain integrity with device_link_id riding outside the canonical,
// and the Community 402. Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { PaymentRequiredError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { requireFixtureActor, requireOrgAuth } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import {
  createDeviceLink,
  requestDeviceLinkCoversFixture,
  revokeDeviceLink,
  getActiveDeviceLink,
  resolveDeviceLinkToken,
  endOfLocalDay,
} from "../device-links";
import { eventRecorderNames } from "../fixtures";

import { setOrgPlan } from "@/lib/__tests__/_billing-group";
const HAS_DB = !!process.env.DATABASE_URL;

const DIVISION_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

async function makeUser(name: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`${name}-${randomUUID().slice(0, 8)}@test.local`}, ${name}, true)
    returning id`;
  return id;
}

async function seedOrg(plan: "community" | "pro" = "pro"): Promise<{
  orgId: string;
  ownerId: string;
}> {
  const suffix = randomUUID().slice(0, 8);
  const ownerId = await makeUser("owner");
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"DL Org " + suffix}, ${"dl-org-" + suffix}, ${ownerId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${ownerId}, 'owner')`;
  if (plan !== "community") {
    await setOrgPlan(orgId, plan);
  }
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(DIVISION_CONFIG)}, true)
    on conflict do nothing`;
  return { orgId, ownerId };
}

const asOwner = (orgId: string, userId: string): AuthCtx => ({
  orgId,
  via: "session",
  userId,
  role: "owner",
  keyId: null,
});

async function rig(owner: AuthCtx) {
  const competition = await createCompetition(owner, {
    ends_on: "2030-12-31",
    name: "DL Cup " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(owner, competition.id, {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  await createEntrants(
    owner,
    division.id,
    ["A", "B", "C", "D"].map((n, i) => ({
      kind: "individual" as const,
      display_name: n,
      seed: i + 1,
      members: [],
    })),
  );
  const [stage] = await createStages(owner, division.id, {
    seq: 1,
    kind: "league",
    name: "L",
    config: {},
  });
  const { fixtures } = await generateStageFixtures(owner, stage.id);
  await startDivision(owner, division.id);
  return { competition, division, stage, fixtures };
}

const dlRequest = (secret: string) =>
  new Request("http://test.local/api/v1", {
    headers: { authorization: `Bearer ${secret}` },
  });

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe("endOfLocalDay (pure)", () => {
  it("returns the next local midnight in the venue tz", () => {
    // 2026-07-06T20:00Z = 2026-07-07T01:30 in Asia/Kolkata (+05:30) → end of
    // that local day = 2026-07-07T24:00 local = 2026-07-07T18:30Z.
    const now = new Date("2026-07-06T20:00:00Z");
    expect(endOfLocalDay(now, "Asia/Kolkata").toISOString()).toBe("2026-07-07T18:30:00.000Z");
    // UTC: plain next midnight.
    expect(endOfLocalDay(now, "UTC").toISOString()).toBe("2026-07-07T00:00:00.000Z");
    // Unknown tz falls back to UTC.
    expect(endOfLocalDay(now, "Not/AZone").toISOString()).toBe("2026-07-07T00:00:00.000Z");
  });
});

describe.skipIf(!HAS_DB)("device links (doc 13 §7, PROMPT-21)", () => {
  it("E2E: mint → score via dl_ → attribution → undo-own → finalize 403 → revoke 401", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { fixtures } = await rig(owner);
    const [fixture, otherFixture] = fixtures;

    // Mint: editor session only; secret shown once with the dl_ prefix.
    const link = await createDeviceLink(owner, fixture.id, "Court 3 phone");
    expect(link.secret.startsWith("dl_")).toBe(true);
    expect(link.issued_by).toBe(ownerId);

    // The dl_ door: only its own fixture.
    const deviceAuth = await requireFixtureActor(dlRequest(link.secret), fixture.id, "score");
    expect(deviceAuth.via).toBe("device_link");
    expect(deviceAuth.userId).toBe(ownerId); // recorded_by = issued_by
    expect(deviceAuth.deviceLinkId).toBe(link.id);
    // Pinned, not merely "an HttpError": a regression to 401/404/500, or a
    // refusal thrown for some unrelated reason, has to fail here. 403 + this
    // message are what api-v1/http.ts puts on the wire verbatim.
    await expect(
      requireFixtureActor(dlRequest(link.secret), otherFixture.id, "score"),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      requireFixtureActor(dlRequest(link.secret), otherFixture.id, "score"),
    ).rejects.toThrowError("This device link is for a different fixture");

    // Every other auth surface: 403 — and pinned, because
    // `PaymentRequiredError extends HttpError` (lib/errors.ts), so a bare
    // `toThrowError(HttpError)` cannot tell an ownership refusal from a 402.
    // In the wave that removes payment refusals from this path, that is the
    // one distinction these assertions exist to make.
    await expect(requireOrgAuth(dlRequest(link.secret), orgId, "read")).rejects.toMatchObject({
      status: 403,
    });
    await expect(requireOrgAuth(dlRequest(link.secret), orgId, "read")).rejects.toThrowError(
      "Device links can only access their fixture's scoring surface",
    );

    // Score winner without any session.
    await scoreEvent(deviceAuth, fixture.id, {
      expected_seq: 0,
      type: "core.start",
      payload: {},
    });
    const scored = await scoreEvent(deviceAuth, fixture.id, {
      expected_seq: 1,
      type: "generic.result",
      payload: { p1Score: 2, p2Score: 1 },
    });
    expect(scored.outcome).not.toBeNull();

    // Attribution rides on the ledger: recorded_by = issuer + device_link_id.
    const events = await sql<
      { type: string; recorded_by: string; device_link_id: string | null }[]
    >`
      select type, recorded_by, device_link_id from score_events
      where fixture_id = ${fixture.id} order by seq`;
    expect(events.every((e) => e.recorded_by === ownerId)).toBe(true);
    expect(events.every((e) => e.device_link_id === link.id)).toBe(true);

    // Activity attribution read model: recorded_by resolves to a display name.
    const [{ display_name: ownerName }] = await sql<{ display_name: string }[]>`
      select display_name from users where id = ${ownerId}`;
    const names = await eventRecorderNames(owner, fixture.id);
    expect(names[ownerId]).toBe(ownerName);

    // Undo own mistake pre-finalize.
    const [{ id: resultEventId }] = await sql<{ id: string }[]>`
      select id from score_events where fixture_id = ${fixture.id} and type = 'generic.result'`;
    const undone = await scoreEvent(deviceAuth, fixture.id, {
      expected_seq: 2,
      type: "core.void",
      payload: { event_id: resultEventId },
    });
    expect(undone.outcome).toBeNull();

    // Cannot void an event another actor recorded.
    const ownerScored = await scoreEvent(owner, fixture.id, {
      expected_seq: 3,
      type: "generic.result",
      payload: { p1Score: 3, p2Score: 0 },
    });
    const [{ id: ownerEventId }] = await sql<{ id: string }[]>`
      select id from score_events
      where fixture_id = ${fixture.id} and seq = ${ownerScored.seq}`;
    const voidOthers = () =>
      scoreEvent(deviceAuth, fixture.id, {
        expected_seq: ownerScored.seq,
        type: "core.void",
        payload: { event_id: ownerEventId },
      });
    await expect(voidOthers()).rejects.toMatchObject({ status: 403 });
    await expect(voidOthers()).rejects.toThrowError("A device link can only undo its own events");

    // Finalize via link → 403 ("finalizing needs a human with a name") — a
    // CAPABILITY refusal, not a payment one, which is exactly what the status
    // and message pins here are for.
    const finalizeViaLink = () =>
      scoreEvent(deviceAuth, fixture.id, {
        expected_seq: ownerScored.seq,
        type: "core.finalize",
        payload: {},
      });
    await expect(finalizeViaLink()).rejects.toMatchObject({ status: 403 });
    await expect(finalizeViaLink()).rejects.toThrowError(
      "Finalizing needs an organiser or scorer account",
    );

    // Hash chain stays clean across device-link + hand-recorded events.
    const [{ bad }] = await sql<{ bad: string | null }[]>`
      select verify_score_events_chain(${fixture.id}) as bad`;
    expect(bad).toBeNull();

    // Revoke → immediate 401 with the distinct code.
    await revokeDeviceLink(owner, fixture.id, link.id);
    await expect(resolveDeviceLinkToken(link.secret)).rejects.toMatchObject({
      status: 401,
      code: "LINK_REVOKED",
    });
  });

  // The ownership guard is what separates "scoring detail is free" from
  // "any device link can score any fixture". Drive the SAME two steps the
  // route drives (requireFixtureActor → scoreEvent on the same id) and prove
  // the door is shut, not merely that a helper threw: scoreEvent carries no
  // fixture-ownership check of its own (AuthCtx has no fixtureId), so if the
  // door ever stopped refusing, the write WOULD land.
  it("cross-fixture: the door refuses 403 and NO event reaches the other fixture", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { fixtures } = await rig(owner);
    const [fixture, otherFixture] = fixtures;
    const link = await createDeviceLink(owner, fixture.id, "Court 3 phone");

    // Verbatim the body of POST /api/v1/fixtures/[id]/events.
    const post = (fixtureId: string) =>
      requireFixtureActor(dlRequest(link.secret), fixtureId, "score").then((auth) =>
        scoreEvent(auth, fixtureId, { expected_seq: 0, type: "core.start", payload: {} }),
      );

    await expect(post(otherFixture.id)).rejects.toMatchObject({ status: 403 });
    await expect(post(otherFixture.id)).rejects.toThrowError(
      "This device link is for a different fixture",
    );
    const [{ n: leaked }] = await sql<{ n: number }[]>`
      select count(*)::int as n from score_events where fixture_id = ${otherFixture.id}`;
    expect(leaked).toBe(0);

    // Control: the same token writes to its OWN fixture, so the 403 above is
    // about ownership — not an invalid token, an unstarted division, or a
    // rejection scoreEvent would have raised for any caller.
    const ok = await post(fixture.id);
    expect(ok.seq).toBe(1);
    const [{ n: own }] = await sql<{ n: number }[]>`
      select count(*)::int as n from score_events where fixture_id = ${fixture.id}`;
    expect(own).toBe(1);

    // Same question, second asker: the public realtime-token route decides
    // fixture ownership for a dl_ token too. It must decide it with the SAME
    // predicate — pinned here so a change to one is a change to both.
    await expect(requestDeviceLinkCoversFixture(dlRequest(link.secret), fixture.id)).resolves.toBe(
      true,
    );
    await expect(
      requestDeviceLinkCoversFixture(dlRequest(link.secret), otherFixture.id),
    ).resolves.toBe(false);
  });

  it("expiry (clock injected) → 401 LINK_EXPIRED; re-mint revokes the old link", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { fixtures } = await rig(owner);
    const fixture = fixtures[0];

    const first = await createDeviceLink(owner, fixture.id, null);
    // Clock injection: force the expiry into the past.
    await sql`update device_links set expires_at = now() - interval '1 minute'
              where id = ${first.id}`;
    await expect(resolveDeviceLinkToken(first.secret)).rejects.toMatchObject({
      status: 401,
      code: "LINK_EXPIRED",
    });
    await sql`update device_links set expires_at = now() + interval '1 hour'
              where id = ${first.id}`;

    // One live device per fixture: minting again revokes the first.
    const second = await createDeviceLink(owner, fixture.id, null);
    await expect(resolveDeviceLinkToken(first.secret)).rejects.toMatchObject({
      code: "LINK_REVOKED",
    });
    await expect(resolveDeviceLinkToken(second.secret)).resolves.toMatchObject({
      fixture_id: fixture.id,
    });

    const active = await getActiveDeviceLink(owner, fixture.id);
    expect(active?.id).toBe(second.id);
  });

  it("migration proof: a chain built BEFORE device_link_id existed still verifies", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { fixtures } = await rig(owner);
    const fixture = fixtures[0];

    // "Old" events: no device_link_id (exactly what pre-migration rows look
    // like after ADD COLUMN — null). Chain must verify…
    await scoreEvent(owner, fixture.id, {
      expected_seq: 0,
      type: "core.start",
      payload: {},
    });
    await scoreEvent(owner, fixture.id, {
      expected_seq: 1,
      type: "generic.result",
      payload: { p1Score: 1, p2Score: 0 },
    });
    const [{ bad: before }] = await sql<{ bad: string | null }[]>`
      select verify_score_events_chain(${fixture.id}) as bad`;
    expect(before).toBeNull();

    // …and a MIXED chain (null rider rows, then device-link rows on top)
    // also verifies — the canonical string never includes device_link_id.
    const mixed = fixtures[1];
    await scoreEvent(owner, mixed.id, {
      expected_seq: 0,
      type: "core.start",
      payload: {},
    });
    const link = await createDeviceLink(owner, mixed.id, null);
    const deviceAuth = await requireFixtureActor(dlRequest(link.secret), mixed.id, "score");
    await scoreEvent(deviceAuth, mixed.id, {
      expected_seq: 1,
      type: "generic.result",
      payload: { p1Score: 0, p2Score: 4 },
    });
    const riders = await sql<{ device_link_id: string | null }[]>`
      select device_link_id from score_events where fixture_id = ${mixed.id} order by seq`;
    expect(riders.map((r) => r.device_link_id)).toEqual([null, link.id]);
    const [{ bad: after }] = await sql<{ bad: string | null }[]>`
      select verify_score_events_chain(${mixed.id}) as bad`;
    expect(after).toBeNull();
  });

  it("Community org: mint → 402 scoring.device_links; account-scorer flow unaffected", async () => {
    const { orgId, ownerId } = await seedOrg("community");
    const owner = asOwner(orgId, ownerId);
    const { fixtures } = await rig(owner);

    await expect(createDeviceLink(owner, fixtures[0].id, null)).rejects.toThrowError(
      PaymentRequiredError,
    );
    // PROMPT-18 path untouched: the owner still scores by session.
    const scored = await scoreEvent(owner, fixtures[0].id, {
      expected_seq: 0,
      type: "core.start",
      payload: {},
    });
    expect(scored.seq).toBe(1);
  });
});
