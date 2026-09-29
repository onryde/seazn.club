// Addendum RT (Task 14b fix round 2; owner decision 2026-09-29): a community org's STREAM OVERLAY gets real-time
// scores. The plan-wide `realtime` entitlement is unchanged — a community spectator page keeps its 15 s poll. The
// overlay bypass mints `fixture:{id}` without `realtime` only when ALL THREE hold:
//   - the caller declares the overlay purpose (the overlay client's `?purpose=overlay`),
//   - the fixture has a stream session in ACTIVE_STATES (it is being broadcast),
//   - the org has `streaming.overlay` (the overlay page's own gate, competition-scoped).
// The purpose is a REQUEST, never an authorisation: every other combination follows today's path.
//
// Driven through the REAL route handler and the real entitlement and session reads on Postgres. Doubled: the JWT
// mint (a spy — the decision is under test, not the signature, and the key is environment-dependent) and the signed-in
// user (null: an anonymous OBS browser source; the officials bypass has its own suites). The request URL is the one
// the overlay CLIENT builds (`realtimeTokenPath`), so the producer's query string is folded through this consumer.
//
// Expected values come from the ruling's rule above, never from the route. Skipped without DATABASE_URL.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));
const seams = vi.hoisted(() => ({ mint: vi.fn(async (fixtureId: string) => `token:${fixtureId}`) }));
vi.mock("@/lib/realtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/realtime")>()),
  mintPublicFixtureToken: (fixtureId: string) => seams.mint(fixtureId),
}));
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getCurrentUser: async () => null,
}));

import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { ACTIVE_STATES, TERMINAL_STATES, type SessionState } from "@/server/relay/domain/session";
import { OVERLAY_REALTIME_PURPOSE, realtimeTokenPath } from "@/components/public-site/live-score-data";
import { GET } from "../route";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

interface Seeded { orgId: string; fixtureId: string }

/** A community org with one PUBLIC fixture (pass-scope-public-realtime.test.ts's seed shape), its two entitlements
 *  set by override so every cell states both explicitly. */
async function seed(opts: { overlay: boolean; realtime: boolean; visibility?: "public" | "private" }): Promise<Seeded> {
  const s = uniq();
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"RT Overlay " + s}, ${"rt-overlay-" + s}) returning id`;
  await sql`
    with _owner as (
      insert into users (email, display_name, email_verified)
      values ('seedowner-' || gen_random_uuid() || '@test.local', 'Seed Owner', true)
      returning id
    ),
    _seed_sub as (
      insert into subscriptions (owner_user_id, plan_key, status)
      select coalesce(o.created_by, (select id from _owner)), 'community', 'active' from organizations o where o.id = ${orgId}
      returning id
    )
    update organizations set subscription_id = (select id from _seed_sub) where id = ${orgId}`;
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility, status)
    values (${orgId}, ${"RT Cup " + s}, ${"rt-cup-" + s}, ${opts.visibility ?? "public"}, 'live') returning id`;
  const [{ id: divId }] = await sql<{ id: string }[]>`
    insert into divisions (org_id, competition_id, name, slug, sport_key, variant_key, status, config, module_version)
    values (${orgId}, ${compId}, 'Open', ${"open-" + s}, 'generic', 'score', 'active',
            ${sql.json({ resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false })}, '1.0.0')
    returning id`;
  const [{ id: stageId }] = await sql<{ id: string }[]>`
    insert into stages (org_id, division_id, kind, name, seq) values (${orgId}, ${divId}, 'league', 'League', 1) returning id`;
  const [{ id: fixtureId }] = await sql<{ id: string }[]>`
    insert into fixtures (org_id, division_id, stage_id, fixture_no, round_no, seq_in_round)
    values (${orgId}, ${divId}, ${stageId}, 1, 1, 1) returning id`;
  for (const [key, value] of [["streaming.overlay", opts.overlay], ["realtime", opts.realtime]] as const) {
    await sql`insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
              values (${orgId}, ${key}, ${value}, 'rt unit')
              on conflict (org_id, feature_key) do update set bool_value = ${value}`;
  }
  await invalidateOrgEntitlements(orgId);
  return { orgId, fixtureId };
}

/** A stream session on the fixture in `state` — a precondition row, not a seam under test (the target's envelope is
 *  never read here). Its columns derive from the fixture's own division, as stream-sessions.test.ts's raw inserts do. */
async function session(fx: Seeded, state: SessionState): Promise<void> {
  const [{ id: targetId }] = await sql<{ id: string }[]>`
    insert into org_stream_targets (org_id, kind, label, rtmp_enc) values (${fx.orgId}, 'youtube', 'Club', '\\x00'::bytea) returning id`;
  await sql`
    insert into fixture_stream_sessions (fixture_id, org_id, mode, state, fail_reason, ended_at, target_id, created_by,
                                         sport_key, competition_id, division_id, entitlement_via_override)
    select ${fx.fixtureId}, ${fx.orgId}, 'passthrough', ${state}, ${state === "failed" ? "no_inbound_timeout" : null},
           ${TERMINAL_STATES.includes(state) ? new Date() : null}, ${targetId}, ${randomUUID()},
           d.sport_key, d.competition_id, f.division_id, true
      from fixtures f join divisions d on d.id = f.division_id where f.id = ${fx.fixtureId}`;
}

async function ask(fixtureId: string, purpose?: string): Promise<{ status: number; minted: boolean }> {
  seams.mint.mockClear();
  // The client's own path for the two values it sends; a hand-built one only for a value no client sends.
  const path = purpose === undefined ? realtimeTokenPath(fixtureId)
    : purpose === OVERLAY_REALTIME_PURPOSE ? realtimeTokenPath(fixtureId, OVERLAY_REALTIME_PURPOSE)
    : `/api/v1/public/fixtures/${fixtureId}/realtime-token?purpose=${encodeURIComponent(purpose)}`;
  const res = await GET(new Request(`http://app.test${path}`), { params: Promise.resolve({ id: fixtureId }) });
  const minted = seams.mint.mock.calls.length === 1;
  if (res.status === 200) {
    const body = (await res.json()) as { data?: { token: string; channel: string } };
    expect(body.data, "a 200 carries the minted token for THIS fixture").toEqual({ token: `token:${fixtureId}`, channel: `fixture:${fixtureId}` });
  }
  return { status: res.status, minted };
}

beforeEach(() => {
  seams.mint.mockClear();
});

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("realtime-token: the overlay bypass (addendum RT)", () => {
  it("the whole table — purpose × active session × streaming.overlay × realtime: mints iff `realtime`, or ALL THREE of the overlay conditions", async () => {
    let checked = 0;
    let minted = 0;
    for (const purpose of [false, true]) {
      for (const active of [false, true]) {
        for (const overlay of [false, true]) {
          for (const realtime of [false, true]) {
            const cell = `purpose=${purpose} active=${active} overlay=${overlay} realtime=${realtime}`;
            const fx = await seed({ overlay, realtime });
            if (active) await session(fx, "live");
            const expected = realtime || (purpose && active && overlay);
            const got = await ask(fx.fixtureId, purpose ? OVERLAY_REALTIME_PURPOSE : undefined);
            expect(got, cell).toEqual(expected ? { status: 200, minted: true } : { status: 403, minted: false });
            if (expected) minted++;
            checked++;
          }
        }
      }
    }
    expect(checked, "every cell of the 2×2×2×2 table").toBe(16);
    // Both answers were exercised: 8 realtime cells + the one overlay cell with realtime off.
    expect(minted).toBe(9);
  });

  it("the purpose flag ALONE never mints — nor with only one of the other two conditions", async () => {
    const cells: { name: string; overlay: boolean; state: SessionState | null }[] = [
      { name: "the flag alone", overlay: false, state: null },
      { name: "flag + streaming.overlay, nothing being streamed", overlay: true, state: null },
      { name: "flag + a live session, no streaming.overlay", overlay: false, state: "live" },
    ];
    let checked = 0;
    for (const c of cells) {
      const fx = await seed({ overlay: c.overlay, realtime: false });
      if (c.state) await session(fx, c.state);
      expect(await ask(fx.fixtureId, OVERLAY_REALTIME_PURPOSE), c.name).toEqual({ status: 403, minted: false });
      checked++;
    }
    expect(checked).toBe(cells.length);
  });

  it("every ACTIVE state mints for the overlay; every TERMINAL state refuses — a finished broadcast is no longer being streamed", async () => {
    let checked = 0;
    for (const state of [...ACTIVE_STATES, ...TERMINAL_STATES]) {
      const fx = await seed({ overlay: true, realtime: false });
      await session(fx, state);
      const expected = ACTIVE_STATES.includes(state);
      expect(await ask(fx.fixtureId, OVERLAY_REALTIME_PURPOSE), state).toEqual(expected ? { status: 200, minted: true } : { status: 403, minted: false });
      checked++;
    }
    expect(checked).toBe(ACTIVE_STATES.length + TERMINAL_STATES.length);
    expect(ACTIVE_STATES.length).toBeGreaterThan(0);
    expect(TERMINAL_STATES.length).toBeGreaterThan(0);
  });

  it("an UNKNOWN purpose is no purpose, and a PRIVATE competition's fixture is refused even with all three conditions", async () => {
    const other = await seed({ overlay: true, realtime: false });
    await session(other, "live");
    expect(await ask(other.fixtureId, "scorepad"), "unknown purpose").toEqual({ status: 403, minted: false });
    // The positive pair on the same fixture: the declared overlay purpose mints.
    expect(await ask(other.fixtureId, OVERLAY_REALTIME_PURPOSE)).toEqual({ status: 200, minted: true });

    const hidden = await seed({ overlay: true, realtime: false, visibility: "private" });
    await session(hidden, "live");
    expect(await ask(hidden.fixtureId, OVERLAY_REALTIME_PURPOSE), "private competition").toEqual({ status: 403, minted: false });
  });
});
