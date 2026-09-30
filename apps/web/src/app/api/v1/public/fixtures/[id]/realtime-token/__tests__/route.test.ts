// RT (lane-close fix, ruled 2026-09-29; supersedes addendum RT's session-based bypass): a community org's STREAM
// OVERLAY gets real-time scores through a SIGNED KEY the organiser's panel puts in the OBS URL it copies. The plan-wide
// `realtime` entitlement is unchanged — a community spectator page keeps its 15 s poll. The route mints `fixture:{id}`
// without `realtime` only when ALL THREE hold:
//   - the caller declares the overlay purpose (`?purpose=overlay`),
//   - `?key=` verifies for THIS fixture (server/overlay/overlay-key.ts, constant-time),
//   - the org has `streaming.overlay` (the overlay page's own gate, competition-scoped).
// A keyless or bad-key request takes today's normal path. Whether a stream session is up no longer matters at all.
//
// Driven through the REAL route handler, the real key module and the real entitlement reads on Postgres. Doubled: the
// JWT mint (a spy — the decision is under test, not the signature) and the signed-in user (null: an anonymous OBS
// browser source; the officials bypass has its own suites). The request URL is the one the overlay CLIENT builds
// (`realtimeTokenPath`), and the key the one the PANEL's page mints (`overlayKeyFor`), so producer and consumer are
// folded through this route rather than a query string typed here.
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
import { ACTIVE_STATES, TERMINAL_STATES } from "@/server/relay/domain/session";
import { rigTarget } from "@/server/relay/__tests__/_session-rig";
import { OVERLAY_REALTIME_PURPOSE, realtimeTokenPath } from "@/components/public-site/live-score-data";
import { overlayKeyFor } from "@/server/overlay/overlay-key";
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

/** A stream session on the fixture in `state` — used only to show that a session no longer matters either way. */
async function session(fx: Seeded, state: string): Promise<void> {
  const targetId = await rigTarget(fx.orgId, "Club"); // the sealed column is named only inside server/relay/** (r3)
  await sql`
    insert into fixture_stream_sessions (fixture_id, org_id, mode, state, fail_reason, ended_at, target_id, created_by,
                                         sport_key, competition_id, division_id, entitlement_via_override)
    select ${fx.fixtureId}, ${fx.orgId}, 'passthrough', ${state}, ${state === "failed" ? "no_inbound_timeout" : null},
           ${(TERMINAL_STATES as readonly string[]).includes(state) ? new Date() : null}, ${targetId}, ${randomUUID()},
           d.sport_key, d.competition_id, f.division_id, true
      from fixtures f join divisions d on d.id = f.division_id where f.id = ${fx.fixtureId}`;
}

/** A bad key that LOOKS right: the fixture's own key with its first character changed — same length, same alphabet. */
const tampered = (key: string): string => (key[0] === "A" ? "B" : "A") + key.slice(1);

async function ask(fixtureId: string, purpose?: string, key?: string): Promise<{ status: number; minted: boolean }> {
  seams.mint.mockClear();
  // The client's own path for the values it sends; a hand-built one only for a purpose no client sends.
  const path = purpose === undefined || purpose === OVERLAY_REALTIME_PURPOSE
    ? realtimeTokenPath(fixtureId, purpose as typeof OVERLAY_REALTIME_PURPOSE | undefined, key)
    : `/api/v1/public/fixtures/${fixtureId}/realtime-token?purpose=${encodeURIComponent(purpose)}${key ? `&key=${encodeURIComponent(key)}` : ""}`;
  const res = await GET(new Request(`http://app.test${path}`), { params: Promise.resolve({ id: fixtureId }) });
  const minted = seams.mint.mock.calls.length === 1;
  if (res.status === 200) {
    const body = (await res.json()) as { data?: { token: string; channel: string } };
    expect(body.data, "a 200 carries the minted token for THIS fixture").toEqual({ token: `token:${fixtureId}`, channel: `fixture:${fixtureId}` });
  }
  return { status: res.status, minted };
}

const SECRET = "rt-route-unit-secret-0123456789abcdef";
beforeEach(() => {
  seams.mint.mockClear();
  // The key module signs with AUTH_SECRET; pinned so the table never depends on the shell that ran it.
  vi.stubEnv("AUTH_SECRET", SECRET);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

const MINT = { status: 200, minted: true } as const;
const REFUSE = { status: 403, minted: false } as const;

describe.skipIf(!HAS_DB)("realtime-token: the overlay's signed key (RT)", () => {
  it("the whole table — purpose × key valid/invalid/absent × streaming.overlay × realtime: mints iff `realtime`, or ALL THREE overlay conditions", async () => {
    const KEYS = ["valid", "invalid", "absent"] as const;
    let checked = 0;
    let minted = 0;
    for (const purpose of [false, true]) {
      for (const key of KEYS) {
        for (const overlay of [false, true]) {
          for (const realtime of [false, true]) {
            const cell = `purpose=${purpose} key=${key} overlay=${overlay} realtime=${realtime}`;
            const fx = await seed({ overlay, realtime });
            const own = overlayKeyFor(fx.fixtureId)!;
            const sent = key === "valid" ? own : key === "invalid" ? tampered(own) : undefined;
            const expected = realtime || (purpose && key === "valid" && overlay);
            expect(await ask(fx.fixtureId, purpose ? OVERLAY_REALTIME_PURPOSE : undefined, sent), cell).toEqual(expected ? MINT : REFUSE);
            if (expected) minted++;
            checked++;
          }
        }
      }
    }
    expect(checked, "every cell of the 2×3×2×2 table").toBe(24);
    // Both answers exercised: the 12 realtime cells, and the ONE overlay cell with realtime off.
    expect(minted).toBe(13);
  });

  it("a FORGED purpose never mints — no key, an empty key, a tampered key, another fixture's key", async () => {
    const fx = await seed({ overlay: true, realtime: false });
    const other = await seed({ overlay: true, realtime: false });
    const forgeries: [string, string | undefined][] = [
      ["no key", undefined],
      ["empty key", ""],
      ["tampered key", tampered(overlayKeyFor(fx.fixtureId)!)],
      ["the other fixture's key", overlayKeyFor(other.fixtureId)!],
      ["a key minted under another secret", "AAAAAAAAAAAAAAAAAAAAAA"],
    ];
    let checked = 0;
    for (const [name, key] of forgeries) {
      expect(await ask(fx.fixtureId, OVERLAY_REALTIME_PURPOSE, key), name).toEqual(REFUSE);
      checked++;
    }
    expect(checked).toBe(forgeries.length);
    // The positive pair on the SAME fixture and org: its own key mints.
    expect(await ask(fx.fixtureId, OVERLAY_REALTIME_PURPOSE, overlayKeyFor(fx.fixtureId)!)).toEqual(MINT);
  });

  it("the key is FIXTURE-BOUND: fixture A's key fails for fixture B of the same org, and B's own key mints", async () => {
    const a = await seed({ overlay: true, realtime: false });
    const b = await seed({ overlay: true, realtime: false });
    expect(await ask(b.fixtureId, OVERLAY_REALTIME_PURPOSE, overlayKeyFor(a.fixtureId)!), "A's key on B").toEqual(REFUSE);
    expect(await ask(a.fixtureId, OVERLAY_REALTIME_PURPOSE, overlayKeyFor(b.fixtureId)!), "B's key on A").toEqual(REFUSE);
    expect(await ask(b.fixtureId, OVERLAY_REALTIME_PURPOSE, overlayKeyFor(b.fixtureId)!), "B's own").toEqual(MINT);
    expect(await ask(a.fixtureId, OVERLAY_REALTIME_PURPOSE, overlayKeyFor(a.fixtureId)!), "A's own").toEqual(MINT);
  });

  it("the session-based bypass is GONE: a keyed overlay mints with no session and after one ended; a live session without the key refuses", async () => {
    const noSession = await seed({ overlay: true, realtime: false });
    expect(await ask(noSession.fixtureId, OVERLAY_REALTIME_PURPOSE, overlayKeyFor(noSession.fixtureId)!), "no session ever").toEqual(MINT);
    let checked = 0;
    for (const state of [...ACTIVE_STATES, ...TERMINAL_STATES]) {
      const fx = await seed({ overlay: true, realtime: false });
      await session(fx, state);
      expect(await ask(fx.fixtureId, OVERLAY_REALTIME_PURPOSE), `${state}, no key`).toEqual(REFUSE);
      expect(await ask(fx.fixtureId, OVERLAY_REALTIME_PURPOSE, overlayKeyFor(fx.fixtureId)!), `${state}, keyed`).toEqual(MINT);
      checked++;
    }
    expect(ACTIVE_STATES.length).toBeGreaterThan(0);
    expect(TERMINAL_STATES.length).toBeGreaterThan(0);
    expect(checked).toBe(ACTIVE_STATES.length + TERMINAL_STATES.length);
  });

  it("an UNKNOWN purpose is no purpose even with a valid key, and a PRIVATE competition's fixture is refused even with all three", async () => {
    const other = await seed({ overlay: true, realtime: false });
    const key = overlayKeyFor(other.fixtureId)!;
    expect(await ask(other.fixtureId, "scorepad", key), "unknown purpose").toEqual(REFUSE);
    // The positive pair on the same fixture: the declared overlay purpose with the same key mints.
    expect(await ask(other.fixtureId, OVERLAY_REALTIME_PURPOSE, key)).toEqual(MINT);

    const hidden = await seed({ overlay: true, realtime: false, visibility: "private" });
    expect(await ask(hidden.fixtureId, OVERLAY_REALTIME_PURPOSE, overlayKeyFor(hidden.fixtureId)!), "private competition").toEqual(REFUSE);
  });

  it("no AUTH_SECRET on the server: nothing verifies, so a keyed overlay takes the normal path (and `realtime` still mints)", async () => {
    const fx = await seed({ overlay: true, realtime: false });
    const key = overlayKeyFor(fx.fixtureId)!;
    vi.stubEnv("AUTH_SECRET", "");
    expect(await ask(fx.fixtureId, OVERLAY_REALTIME_PURPOSE, key)).toEqual(REFUSE);
    const paid = await seed({ overlay: true, realtime: true });
    expect(await ask(paid.fixtureId, OVERLAY_REALTIME_PURPOSE, key), "the normal path is untouched").toEqual(MINT);
  });
});
