// R2005 change 1 — the overlay PAGE's relay access, driven through the REAL page against a REAL fixture, a REAL composed
// session row and REAL relay tokens (brief Step 2, tests 1–7, 5b and 10).
//
// A composed session can stream a fixture that is NOT public (a private competition). Today's visibility gate 404s the
// compositor's page there and the stream goes out with no score bug — an inert seam the owner would only see live. So
// `sid` + `st` (both present) open a second door: the relay page token verified for that sid, the session on THIS
// fixture, composed and not terminal. Every failure is the same opaque 404 as a missing fixture.
//
// CACHE ISOLATION (test 7) is the security half: the bypass read must never feed a public read. `next/cache` and the
// Redis layer (`@/lib/cache`) are doubled with MEMOIZING in-memory stores, so a bypass that wrote into a public key
// WOULD be served to the next public read here — a passthrough double could never show that.
//
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const memo = vi.hoisted(() => ({ next: new Map<string, unknown>(), redis: new Map<string, unknown>() }));
vi.mock("next/cache", () => ({
  unstable_cache:
    (fn: (...args: unknown[]) => Promise<unknown>, keyParts: string[] = []) =>
    async (...args: unknown[]) => {
      const key = JSON.stringify(keyParts);
      if (memo.next.has(key)) return memo.next.get(key);
      const value = await fn(...args);
      memo.next.set(key, value);
      return value;
    },
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));
vi.mock("@/lib/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cache")>()),
  cacheEnabled: () => true,
  cacheGet: async (key: string) => (memo.redis.has(key) ? memo.redis.get(key) : null),
  cacheSet: async (key: string, value: unknown) => void memo.redis.set(key, JSON.parse(JSON.stringify(value))),
  cacheDel: async (...keys: string[]) => keys.forEach((k) => memo.redis.delete(k)),
  // `invalidateOrgEntitlements` clears by glob; only a trailing `*` is used here.
  cacheDelPattern: async (pattern: string) => {
    const prefix = pattern.replace(/\*$/, "");
    for (const k of [...memo.redis.keys()]) if (k.startsWith(prefix)) memo.redis.delete(k);
  },
}));

import { sql } from "@/lib/db";
import { appendEvent } from "@/server/engine-db/append-event";
import {
  KNOCKOUT_CLUB_CODES,
  endRelaySessions,
  ensureRelaySecret,
  relaySession,
  relayToken,
  seedOverlayKnockoutRig,
  seedOverlayRig,
  type OverlayKnockoutRig,
  type OverlayRig,
} from "@/server/overlay/__tests__/_relay-overlay-rig";
import { getPublicFixture, publicFixtureSlugs } from "@/server/public-site/data";
import { teamShortOf } from "@/lib/public-site";
import { GET as OVERLAY_ROUTE } from "@/app/api/v1/public/fixtures/[id]/overlay/route";
import OverlayPage from "../page";

const HAS_DB = !!process.env.DATABASE_URL;
const NOT_FOUND = "NEXT_HTTP_ERROR_FALLBACK;404";

type Visit = { status: 200; el: ReactElement } | { status: 404 };
async function visit(fixtureId: string, query: Record<string, string> = {}): Promise<Visit> {
  try {
    const el = (await OverlayPage({ params: Promise.resolve({ fixtureId }), searchParams: Promise.resolve(query) })) as ReactElement;
    return { status: 200, el };
  } catch (err) {
    const digest = (err as { digest?: string }).digest;
    if (digest === NOT_FOUND) return { status: 404 };
    throw err;
  }
}
const propsOf = (v: Visit) => {
  if (v.status !== 200) throw new Error("expected a page");
  return v.el.props as Record<string, unknown>;
};
const publicRoute = (id: string) =>
  OVERLAY_ROUTE(new Request(`https://test.local/api/v1/public/fixtures/${id}/overlay`, { headers: { "x-forwarded-for": "10.9.9.9" } }), {
    params: Promise.resolve({ id }),
  });

let restoreSecret: () => void = () => {};
let priv: OverlayRig;
let pub: OverlayRig;
beforeAll(async () => {
  if (!HAS_DB) return;
  restoreSecret = ensureRelaySecret();
  priv = await seedOverlayRig("private");
  pub = await seedOverlayRig("public");
});
afterAll(async () => {
  restoreSecret();
  if (!HAS_DB) return;
  await endRelaySessions();
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

describe.skipIf(!HAS_DB)("the overlay page's relay access (R2005 change 1)", () => {
  it("the positive pair first: the private fixture 404s on the public path (no params)", async () => {
    expect((await visit(priv.fixtureId)).status).toBe(404);
    expect((await visit(pub.fixtureId)).status, "and a public one renders").toBe(200);
  });

  it("1. a private fixture + a valid sid/st for a composed live session on it: 200, the stage polls with that access", async () => {
    const sid = await relaySession(priv, priv.fixtureId);
    const st = await relayToken(sid);
    const v = await visit(priv.fixtureId, { sid, st, host: "compositor", delay: "0" });
    expect(v.status).toBe(200);
    const p = propsOf(v);
    expect(p.fixtureId).toBe(priv.fixtureId);
    expect(p.relay).toEqual({ sid, st });
    expect(p.host).toBe("compositor");
    expect((p.sides as Array<{ name: string }>).map((s) => s.name).sort(), "the bypass read names the sides").toEqual([...priv.names].sort());
  });

  it("2. the same without st: 404 (and without sid: 404)", async () => {
    const sid = await relaySession(priv, priv.fixtureId);
    const st = await relayToken(sid);
    expect((await visit(priv.fixtureId, { sid })).status).toBe(404);
    expect((await visit(priv.fixtureId, { st })).status).toBe(404);
  });

  it("3. st minted for ANOTHER session's sid: 404", async () => {
    const otherSid = await relaySession(priv, priv.otherFixtureId);
    const sid = await relaySession(priv, priv.fixtureId);
    expect((await visit(priv.fixtureId, { sid, st: await relayToken(otherSid) })).status).toBe(404);
  });

  it("4. st with scope relay-job: 404 (only a relay-page token opens the page)", async () => {
    const sid = await relaySession(priv, priv.fixtureId);
    expect((await visit(priv.fixtureId, { sid, st: await relayToken(sid, "relay-job") })).status).toBe(404);
  });

  it("5. an ended session — completed, and failed: 404", async () => {
    for (const state of ["completed", "failed"]) {
      const sid = await relaySession(priv, priv.fixtureId, { state });
      expect((await visit(priv.fixtureId, { sid, st: await relayToken(sid) })).status, state).toBe(404);
    }
  });

  it("5b. an ENDING session (the compositor's final hold): 200, so a CEF reload during the hold loads", async () => {
    const sid = await relaySession(priv, priv.fixtureId, { state: "ending" });
    expect((await visit(priv.fixtureId, { sid, st: await relayToken(sid) })).status).toBe(200);
  });

  it("every non-terminal state opens it (the declared ACTIVE set), every terminal one does not", async () => {
    const OPEN = ["requested", "provisioning", "warming", "live", "ending"];
    const SHUT = ["completed", "failed"];
    let checked = 0;
    for (const state of [...OPEN, ...SHUT]) {
      const sid = await relaySession(priv, priv.fixtureId, { state });
      expect((await visit(priv.fixtureId, { sid, st: await relayToken(sid) })).status, state).toBe(OPEN.includes(state) ? 200 : 404);
      checked++;
    }
    console.log(`session states checked: ${checked}`);
    expect(checked).toBe(7);
  });

  it("a passthrough session (no compositor): 404", async () => {
    const sid = await relaySession(priv, priv.fixtureId, { mode: "passthrough" });
    expect((await visit(priv.fixtureId, { sid, st: await relayToken(sid) })).status).toBe(404);
  });

  it("6. a session on a DIFFERENT fixture: 404", async () => {
    const sid = await relaySession(priv, priv.otherFixtureId);
    expect((await visit(priv.fixtureId, { sid, st: await relayToken(sid) })).status).toBe(404);
  });

  it("a bad relay access on a PUBLIC fixture is a 404 too (any failure is the opaque 404), not a silent public render", async () => {
    const sid = await relaySession(pub, pub.fixtureId);
    expect((await visit(pub.fixtureId, { sid, st: "not-a-token" })).status).toBe(404);
    expect((await visit(pub.fixtureId, { sid, st: await relayToken(sid) })).status, "a good one renders").toBe(200);
  });

  it("the entitlement gate still applies on the relay path", async () => {
    const sid = await relaySession(priv, priv.fixtureId);
    const st = await relayToken(sid);
    await sql`update org_entitlement_overrides set bool_value = false where org_id = ${priv.orgId} and feature_key = 'streaming.overlay'`;
    const { invalidateOrgEntitlements } = await import("@/lib/entitlements");
    await invalidateOrgEntitlements(priv.orgId);
    try {
      expect((await visit(priv.fixtureId, { sid, st })).status).toBe(404);
    } finally {
      await sql`update org_entitlement_overrides set bool_value = true where org_id = ${priv.orgId} and feature_key = 'streaming.overlay'`;
      await invalidateOrgEntitlements(priv.orgId);
    }
  });

  it("a MISCONFIGURED signer (no AUTH_SECRET) is an outage, not a 404 — refusals are 404s, a broken config is not", async () => {
    const sid = await relaySession(priv, priv.fixtureId);
    const st = await relayToken(sid);
    const saved = process.env.AUTH_SECRET;
    delete process.env.AUTH_SECRET;
    try {
      await expect(visit(priv.fixtureId, { sid, st })).rejects.toThrow(/AUTH_SECRET/);
    } finally {
      process.env.AUTH_SECRET = saved;
    }
    expect((await visit(priv.fixtureId, { sid, st })).status, "and with it back, the page loads").toBe(200);
  });

  it("7. cache isolation: a bypass read of a private fixture, then the PUBLIC page and the PUBLIC route for it: still 404", async () => {
    const sid = await relaySession(priv, priv.fixtureId);
    const st = await relayToken(sid);
    expect((await visit(priv.fixtureId, { sid, st })).status).toBe(200);
    const relayRoute = await OVERLAY_ROUTE(
      new Request(`https://test.local/api/v1/public/fixtures/${priv.fixtureId}/overlay?sid=${sid}&st=${st}`, { headers: { "x-forwarded-for": "10.9.9.8" } }),
      { params: Promise.resolve({ id: priv.fixtureId }) },
    );
    expect(relayRoute.status, "the bypass read really ran").toBe(200);
    expect(memo.next.size + memo.redis.size, "the doubles really memoize (or this proves nothing)").toBeGreaterThan(0);
    expect((await visit(priv.fixtureId)).status, "the public page").toBe(404);
    expect((await publicRoute(priv.fixtureId)).status, "the public route").toBe(404);
  });

  it("7b. the fold: a relay read and a public read of the SAME fixture fold under two namespaces, never one entry", async () => {
    await appendEvent(pub.orgId, pub.fixtureId, 0, { type: "core.start", payload: {} });
    const sid = await relaySession(pub, pub.fixtureId);
    const st = await relayToken(sid);
    const foldKeys = () => [...memo.next.keys()].filter((k) => k.includes(pub.fixtureId) && k.includes("overlay-fold"));
    expect(foldKeys(), "nothing folded this fixture yet").toEqual([]);
    expect((await visit(pub.fixtureId, { sid, st })).status).toBe(200);
    const relayKeys = foldKeys();
    expect(relayKeys, "the relay read folded once").toHaveLength(1);
    // Earlier cases cached the public ROW before the ledger moved (its 30 s Redis window): expire it, as time would.
    memo.redis.clear();
    expect((await visit(pub.fixtureId)).status).toBe(200);
    const all = foldKeys();
    expect(all, "the public read folded on its OWN entry, not the relay one").toHaveLength(2);
    expect(new Set(all.map((k) => (JSON.parse(k) as string[])[0])).size, "two namespaces").toBe(2);
  });

  it("8. without sid/st the page is unchanged: ?host=compositor alone, or sid alone, renders the SAME markup and props", async () => {
    const BEFORE = ["decidedTemplates", "delayMs", "dict", "fit", "fixtureId", "initial", "realtime", "sides", "slateMeta", "sportKey", "startLabel", "style"];
    const plain = await visit(pub.fixtureId);
    const html = renderToStaticMarkup((plain as { el: ReactElement }).el);
    expect(html, "the positive pair: the overlay rendered").toContain('data-testid="ovl-root"');
    expect(Object.keys(propsOf(plain)).sort(), "the props the page passed before R2005, and only those").toEqual(BEFORE);
    let checked = 0;
    const variants: Record<string, string>[] = [{ host: "compositor" }, { sid: randomUUID() }, { st: "x" }, { host: "compositor", sid: randomUUID() }];
    for (const query of variants) {
      const v = await visit(pub.fixtureId, query);
      const label = JSON.stringify(Object.keys(query));
      expect(propsOf(v), label).toEqual(propsOf(plain));
      const other = renderToStaticMarkup((v as { el: ReactElement }).el);
      expect(other, label).toBe(html);
      checked++;
    }
    // Anchored on `="` (AGENTS.md: an omitted prop serialises as "$undefined"): no scene, no host on the public render.
    expect(html).not.toMatch(/data-scene="/);
    expect(html).not.toMatch(/data-testid="ovl-scene"/);
    console.log(`public variants checked: ${checked}`);
    expect(checked).toBe(4);
  });

  it("10. the page never sets sceneOverride — with host=compositor and without it", async () => {
    const sid = await relaySession(priv, priv.fixtureId);
    const st = await relayToken(sid);
    let checked = 0;
    const queries: Record<string, string>[] = [{ sid, st, host: "compositor" }, { sid, st }];
    for (const query of queries) {
      const p = propsOf(await visit(priv.fixtureId, query));
      expect("sceneOverride" in p, JSON.stringify(Object.keys(query))).toBe(false);
      checked++;
    }
    const p = propsOf(await visit(pub.fixtureId, { host: "compositor" }));
    expect("sceneOverride" in p).toBe(false);
    expect("host" in p, "host is honoured only with a verified relay access").toBe(false);
    checked++;
    expect(checked).toBe(3);
  });
});

// #987 review I1 / M7 — the side codes the overlay airs, through its two REAL doors (the public read the match centre
// builds, and the relay door's own base-table read), on a public eight-club TEAM knockout. A seated pair the team rule
// cannot tell apart widens; a placeholder seat never does — two placeholders, or a seated club facing one, read the
// team rule on each side exactly as before the ladder, never an ordinal that reads as data (WIN1 / WIN2, "?1" / "?2").
describe.skipIf(!HAS_DB)("the overlay page's side codes through BOTH doors (#987 review I1 / M7)", () => {
  let ko: OverlayKnockoutRig;
  beforeAll(async () => {
    ko = await seedOverlayKnockoutRig();
  });
  const shortsOf = (v: Visit) => (propsOf(v).sides as Array<{ short?: string | null }>).map((s) => s.short);
  const relayVisit = async (fixtureId: string) => {
    const sid = await relaySession(ko, fixtureId);
    return visit(fixtureId, { sid, st: await relayToken(sid) });
  };
  /** The two sides as the public match centre names them (a placeholder seat reads its slot sentence). */
  const matchCentreNames = async (fixtureId: string): Promise<[string, string]> => {
    const slugs = await publicFixtureSlugs(fixtureId);
    const data = await getPublicFixture(slugs!.orgSlug, slugs!.compSlug, slugs!.divSlug, fixtureId);
    const [home, away] = data!.matchCentre.header.sides;
    return [home.name, away.name];
  };

  it("a SEATED pair the team rule cannot tell apart: both doors read the same two widened codes (worked by hand)", async () => {
    const [a, b] = ko.seated.names;
    expect(teamShortOf(a), "premise: the team rule alone collides").toBe(teamShortOf(b));
    const want = [KNOCKOUT_CLUB_CODES[a], KNOCKOUT_CLUB_CODES[b]];
    expect(want.every((code) => typeof code === "string"), `premise: both clubs are in the hand table (${a} / ${b})`).toBe(true);
    expect(shortsOf(await visit(ko.seated.id)), "the public door").toEqual(want);
    expect(shortsOf(await relayVisit(ko.seated.id)), "the relay door").toEqual(want);
  });

  it("a PLACEHOLDER pair keeps the team rule on each side: the public door its slot sentences' codes, the relay door '?' / '?'", async () => {
    const [a, b] = await matchCentreNames(ko.placeholder);
    expect(a, "premise: two different slot sentences").not.toBe(b);
    expect(teamShortOf(a), "premise: they collide under the team rule").toBe(teamShortOf(b));
    expect(shortsOf(await visit(ko.placeholder)), "the public door").toEqual([teamShortOf(a), teamShortOf(b)]);
    expect(shortsOf(await relayVisit(ko.placeholder)), "the relay door: two empty seats").toEqual(["?", "?"]);
  });

  it("a MIXED pair — a seated club facing a placeholder it collides with — keeps the team rule on each side, both doors", async () => {
    const [a, b] = await matchCentreNames(ko.mixed);
    expect(a, "premise: the home seat holds the club").toBe(ko.mixedHome);
    expect(teamShortOf(a), "premise: the club collides with the slot sentence").toBe(teamShortOf(b));
    expect(shortsOf(await visit(ko.mixed)), "the public door").toEqual([teamShortOf(a), teamShortOf(b)]);
    expect(shortsOf(await relayVisit(ko.mixed)), "the relay door").toEqual([teamShortOf(ko.mixedHome), "?"]);
  });
});
