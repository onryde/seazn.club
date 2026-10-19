// R2005 A4 — fallback B on the overlay route: a verified composed session's compositor polls with `sid` + `st` and gets
// the programme phase its LAST STORED BEAT carried, privately; everyone else gets today's public answer, exactly.
// Driven through the REAL route handler against a REAL fixture, a REAL session row whose `last_heartbeat` is the jsonb
// the heartbeat writer stores, and REAL relay tokens.
//
// The two Cache-Control values are typed here from the brief (A4: `private, no-store`) and from the route's existing
// public contract (I9's `public, s-maxage=2, stale-while-revalidate=30`) — never imported from the route.
//
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));

import { endRelaySessions, ensureRelaySecret, relaySession, relayToken, seedOverlayRig, type OverlayRig } from "@/server/overlay/__tests__/_relay-overlay-rig";
import { GET } from "../route";

const HAS_DB = !!process.env.DATABASE_URL;
const PRIVATE = "private, no-store";
const PUBLIC = "public, s-maxage=2, stale-while-revalidate=30";

async function poll(id: string, q: Record<string, string> = {}) {
  const qs = new URLSearchParams(q).toString();
  const res = await GET(
    new Request(`https://test.local/api/v1/public/fixtures/${id}/overlay${qs ? `?${qs}` : ""}`, {
      headers: { "x-forwarded-for": "10.7.7." + Math.floor(Math.random() * 250) },
    }),
    { params: Promise.resolve({ id }) },
  );
  const body = (await res.json()) as { ok: boolean; data?: Record<string, unknown> };
  return { status: res.status, cc: res.headers.get("cache-control"), data: body.data };
}

let restoreSecret: () => void = () => {};
let pub: OverlayRig;
let priv: OverlayRig;
beforeAll(async () => {
  if (!HAS_DB) return;
  restoreSecret = ensureRelaySecret();
  pub = await seedOverlayRig("public");
  priv = await seedOverlayRig("private");
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

describe.skipIf(!HAS_DB)("A4 — the overlay route's relay answer (fallback B)", () => {
  it("a verified composed sid/st gets the stored beat's programmePhase, private + no-store; the public poll straight after has neither", async () => {
    const sid = await relaySession(pub, pub.fixtureId, { heartbeat: { programmePhase: "reconnecting", alive: true } });
    const relay = await poll(pub.fixtureId, { sid, st: await relayToken(sid) });
    expect(relay.status).toBe(200);
    expect(relay.data?.programmePhase).toBe("reconnecting");
    expect(relay.cc).toBe(PRIVATE);
    const after = await poll(pub.fixtureId);
    expect(after.status).toBe(200);
    expect(after.data && "programmePhase" in after.data, "no programmePhase key on the public answer").toBe(false);
    expect(after.cc).toBe(PUBLIC);
  });

  it("every declared phase the beat may carry reaches the compositor as stored", async () => {
    let checked = 0;
    for (const phase of ["waiting", "live", "frozen", "reconnecting", "final"]) {
      const sid = await relaySession(pub, pub.fixtureId, { heartbeat: { programmePhase: phase } });
      expect((await poll(pub.fixtureId, { sid, st: await relayToken(sid) })).data?.programmePhase, phase).toBe(phase);
      checked++;
    }
    console.log(`phases checked: ${checked}`);
    expect(checked).toBe(5);
  });

  it("a wrong st, a job-scope st, another session's st, and a missing st: the public answer exactly (no key, public cache)", async () => {
    const sid = await relaySession(pub, pub.otherFixtureId, { heartbeat: { programmePhase: "final" } });
    const own = await relaySession(pub, pub.fixtureId, { heartbeat: { programmePhase: "reconnecting" } });
    const plain = await poll(pub.fixtureId);
    let checked = 0;
    for (const [label, q] of [
      ["garbage st", { sid: own, st: "not-a-token" }],
      ["relay-job st", { sid: own, st: await relayToken(own, "relay-job") }],
      ["another session's st", { sid: own, st: await relayToken(sid) }],
      ["a session on another fixture", { sid, st: await relayToken(sid) }],
      ["sid only", { sid: own }],
    ] as const) {
      const r = await poll(pub.fixtureId, q as Record<string, string>);
      expect(r.status, label).toBe(200);
      expect(r.cc, label).toBe(PUBLIC);
      expect(r.data && "programmePhase" in r.data, label).toBe(false);
      expect(r.data, label).toEqual(plain.data);
      checked++;
    }
    console.log(`refusals checked: ${checked}`);
    expect(checked).toBe(5);
  });

  it("a beat with no programmePhase — and no beat at all, and an undeclared value — leaves the key ABSENT (never defaulted)", async () => {
    let checked = 0;
    for (const heartbeat of [{ alive: true }, null, { programmePhase: "intermission" }, { programmePhase: null }]) {
      const sid = await relaySession(pub, pub.fixtureId, { heartbeat });
      const r = await poll(pub.fixtureId, { sid, st: await relayToken(sid) });
      expect(r.cc, JSON.stringify(heartbeat)).toBe(PRIVATE);
      expect(r.data && "programmePhase" in r.data, JSON.stringify(heartbeat)).toBe(false);
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("(I5) an ENDING session's beat saying final: served final; a COMPLETED one: the public answer", async () => {
    const ending = await relaySession(pub, pub.fixtureId, { state: "ending", heartbeat: { programmePhase: "final" } });
    const held = await poll(pub.fixtureId, { sid: ending, st: await relayToken(ending) });
    expect(held.data?.programmePhase).toBe("final");
    expect(held.cc).toBe(PRIVATE);
    const done = await relaySession(pub, pub.fixtureId, { state: "completed", heartbeat: { programmePhase: "final" } });
    const after = await poll(pub.fixtureId, { sid: done, st: await relayToken(done) });
    expect(after.cc).toBe(PUBLIC);
    expect(after.data && "programmePhase" in after.data).toBe(false);
  });

  it("a passthrough session: the public answer", async () => {
    const sid = await relaySession(pub, pub.fixtureId, { mode: "passthrough", heartbeat: { programmePhase: "live" } });
    const r = await poll(pub.fixtureId, { sid, st: await relayToken(sid) });
    expect(r.cc).toBe(PUBLIC);
    expect(r.data && "programmePhase" in r.data).toBe(false);
  });

  it("a PRIVATE fixture: the relay answer serves it; the public poll 404s, and a refused relay poll 404s as the public one does", async () => {
    const sid = await relaySession(priv, priv.fixtureId, { heartbeat: { programmePhase: "live" } });
    const r = await poll(priv.fixtureId, { sid, st: await relayToken(sid) });
    expect(r.status).toBe(200);
    expect(r.data?.programmePhase).toBe("live");
    expect(r.data?.status, "the bypass row's own fields").toBeTypeOf("string");
    expect((await poll(priv.fixtureId)).status).toBe(404);
    expect((await poll(priv.fixtureId, { sid, st: "not-a-token" })).status).toBe(404);
  });

  it("a repeated sid is not a relay request", async () => {
    const sid = await relaySession(pub, pub.fixtureId, { heartbeat: { programmePhase: "live" } });
    const st = await relayToken(sid);
    const res = await GET(
      new Request(`https://test.local/api/v1/public/fixtures/${pub.fixtureId}/overlay?sid=${sid}&sid=${sid}&st=${st}`, {
        headers: { "x-forwarded-for": "10.7.8.1" },
      }),
      { params: Promise.resolve({ id: pub.fixtureId }) },
    );
    expect(res.headers.get("cache-control")).toBe(PUBLIC);
  });
});
