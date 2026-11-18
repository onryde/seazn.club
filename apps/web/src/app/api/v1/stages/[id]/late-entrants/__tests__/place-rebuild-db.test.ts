// W5 B5 fix wave G1 (B5 batch review I1 + m2) — the waiting strip's "Rebuild fixtures" (`POST /stages/{id}/late-entrants/
// {entrantId}/place` with `prefer_rebuild`) driven through the REAL route handler on a real database: only the auth door is
// stubbed (it reads a session cookie); the body parse, the dispatch, the usecase and every write are the product's own.
//
// I1: the strip's Rebuild must be the card's Rebuild. A manual rank (a pin) names a place in ONE pool's table, so a redraw drops
// the pins of every pool whose membership changed and keeps the pins of a pool that came out the same (W5 T18, RB5-P5 / RB5-L17).
// differential: today (880f1529b7) the strip's redraw keeps EVERY pin — `P5@1/A` survives a seed-50 arrival that joins pool A, and
// with a seed-0 arrival the snake shifts both pools yet both pins stay; the answer carries no `pins_cleared`.
//
// Oracle: a parallel real path, never the code under test — the CARD's Rebuild (`rebuildStageFixtures`) run on a TWIN division
// built identically (same field, same pins, same arrival), whose surviving pins and `pins_cleared` the strip's must equal. The
// rule itself is ALSO re-derived here from the stored seats (a pin survives iff its pool's members before and after the redraw are
// the same set), so a twin that drifted with the strip could not pass both. Arrival seeds: 50 (joins the tail of the snake: one pool
// changes, the other keeps its pin) and 0 (heads the snake: every pool reshuffles), so both answers — kept and dropped — occur.
//
// m2: the strip's Rebuild draws in EVERY waiting player, not only the one pressed — so the answer names them all (`drawn_in`) and
// the ledger writes one `roundrobin_late_entry` row per player drawn in, each with that player's own lines.
//
// Single sport (badminton singles): the pin rule and the redraw read pool membership, never a sport field.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { confirmRegistration } from "@/server/usecases/registrations";
import { startDivision } from "@/server/usecases/schedule";
import { createStages, overrideStandings, rebuildStageFixtures } from "@/server/usecases/stages";
import { seedRegistration } from "@/server/usecases/__tests__/_registration-fixtures";
import { seedOrg } from "@/server/usecases/__tests__/_seed";

vi.mock("@/server/email-outbox/transport", () => ({ deliver: vi.fn() }));
const current = vi.hoisted(() => ({ auth: null as AuthCtx | null }));
vi.mock("@/server/api-v1/auth", async (io) => ({
  ...(await io<typeof import("@/server/api-v1/auth")>()),
  requireResourceAuth: vi.fn(async () => {
    if (current.auth === null) throw new Error("test: no auth set");
    return current.auth;
  }),
}));

import { POST } from "../[entrantId]/place/route";

const HAS_DB = !!process.env.DATABASE_URL;
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

const BADMINTON = (() => {
  const m = builtinModules.find((x) => x.key === "badminton");
  if (m === undefined) throw new Error("no engine module badminton");
  return { key: "badminton", variant: Object.keys(m.variants)[0]! };
})();

interface Rig {
  auth: AuthCtx;
  competitionId: string;
  divisionId: string;
  stageId: string;
}

/** Eight players seeded 1..8 in a two-pool group, started; a rank-1 pin on the last-listed member of each pool. */
async function pinnedGroup(): Promise<Rig> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "B5 G1 " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const division = await createDivision(auth, comp.id, { name: "Open", slug: "open-" + randomUUID().slice(0, 6), sport_key: BADMINTON.key, variant_key: BADMINTON.variant, config: {} });
  await createEntrants(auth, division.id, Array.from({ length: 8 }, (_, i) => ({ kind: "individual" as const, display_name: `P${i + 1}`, seed: i + 1, members: [] })));
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "group", name: "Table", config: { legs: 1, pools: { count: 2 } }, progression: null });
  await startDivision(auth, division.id);
  const r = { auth, competitionId: comp.id, divisionId: division.id, stageId: stage!.id };
  const seats = await seatsByPool(r.stageId);
  expect(seats.size, "premise: two pools drawn").toBe(2);
  const rows = [...seats.values()].map((names) => ({ entrant_id: names.ids[names.ids.length - 1]!, rank: 1, reason: "B5 G1" }));
  expect(await overrideStandings(auth, r.stageId, { rows }), "premise: one pin per pool").toEqual({ overridden: 2 });
  return r;
}

/** A free confirmation through the real automatic door (it waits on the table), then its seed set for the snake. */
async function arrive(r: Rig, name: string, seed: number): Promise<string> {
  const { registration } = await seedRegistration(r.competitionId, r.divisionId, { fee_cents: 0, currency: "eur", payment_method: "offline" }, { displayName: name });
  const confirmed = await confirmRegistration(r.auth, registration.id);
  const id = confirmed.entrant_id!;
  await sql`update entrants set seed = ${seed} where id = ${id}`;
  const [{ w }] = await sql<{ w: string | null }[]>`select table_waiting_stage_id as w from entrants where id = ${id}`;
  expect(w, `premise: ${name} waits on the table`).toBe(r.stageId);
  return id;
}

/** pool key -> the entrants seated on its stored lines (ids in listed order, and names as a sorted set). */
async function seatsByPool(stageId: string): Promise<Map<string, { ids: string[]; names: string }>> {
  const rows = await sql<{ key: string; id: string; name: string }[]>`
    select distinct p.key, e.id, e.display_name as name, e.seed, e.created_at from pools p
      join fixtures f on f.pool_id = p.id
      join entrants e on e.id in (f.home_entrant_id, f.away_entrant_id)
     where p.stage_id = ${stageId}
     order by p.key, e.seed nulls last, e.created_at, e.id`;
  const out = new Map<string, { ids: string[]; names: string[] }>();
  for (const row of rows) {
    const cur = out.get(row.key) ?? { ids: [], names: [] };
    cur.ids.push(row.id);
    cur.names.push(row.name);
    out.set(row.key, cur);
  }
  return new Map([...out].map(([k, v]) => [k, { ids: v.ids, names: [...v.names].sort().join(",") }]));
}

/** The stage's pins as `name@rank/poolKey`, sorted. */
async function pins(stageId: string): Promise<string[]> {
  const [{ config }] = await sql<{ config: { rank_overrides?: { entrant_id: string; rank: number; pool_id?: string | null }[] } }[]>`
    select config from stages where id = ${stageId}`;
  const names = new Map((await sql<{ id: string; n: string }[]>`select e.id, e.display_name as n from entrants e join stages s on s.division_id = e.division_id where s.id = ${stageId}`).map((e) => [e.id, e.n]));
  const keys = new Map((await sql<{ id: string; key: string }[]>`select id, key from pools where stage_id = ${stageId}`).map((p) => [p.id, p.key]));
  return (config.rank_overrides ?? []).map((p) => `${names.get(p.entrant_id)}@${p.rank}/${p.pool_id ? keys.get(p.pool_id) : "-"}`).sort();
}

/** The strip's tap, through the real handler and its `v1()` envelope. */
async function stripRebuild(r: Rig, entrantId: string): Promise<{ status: number; body: { ok: boolean; data?: Record<string, unknown>; error?: { code?: string } } }> {
  current.auth = r.auth;
  const res = await POST(
    new Request(`http://localhost/api/v1/stages/${r.stageId}/late-entrants/${entrantId}/place`, { method: "POST", body: JSON.stringify({ prefer_rebuild: true }) }),
    { params: Promise.resolve({ id: r.stageId, entrantId }) },
  );
  return { status: res.status, body: (await res.json()) as never };
}

describe.skipIf(!HAS_DB)("G1 the waiting strip's Rebuild is the card's Rebuild (I1, m2)", () => {
  it("I1 pins: the strip's redraw keeps and drops exactly the pins the card's Rebuild does, on a twin division (arrival seeds 50 and 0)", async () => {
    let kept = 0;
    let dropped = 0;
    let checked = 0;
    for (const seed of [50, 0]) {
      const card = await pinnedGroup();
      const strip = await pinnedGroup();
      const before = { card: await seatsByPool(card.stageId), strip: await seatsByPool(strip.stageId) };
      expect(await pins(strip.stageId), `seed ${seed}: twins start the same`).toEqual(await pins(card.stageId));
      await arrive(card, "Waiter", seed);
      const waiter = await arrive(strip, "Waiter", seed);

      const cardOut = await rebuildStageFixtures(card.auth, card.stageId);
      const stripOut = await stripRebuild(strip, waiter);
      expect(stripOut.status, `seed ${seed}: ${JSON.stringify(stripOut.body)}`).toBe(200);
      expect(stripOut.body.data).toMatchObject({ case: "rebuild_offered", reason: "rebuilt" });

      // The twins drew the same seats (premise of the differential).
      const after = { card: await seatsByPool(card.stageId), strip: await seatsByPool(strip.stageId) };
      const names = (m: Map<string, { names: string }>) => [...m].map(([k, v]) => `${k}=[${v.names}]`).sort();
      expect(names(after.strip), `seed ${seed}: the twins redrew alike`).toEqual(names(after.card));

      // The rule, re-derived from the stored seats: a pool keeps its pin iff it came out with the same members.
      const pinsBefore = await pinsBeforeFromSeats(before.strip);
      const derived = pinsBefore.filter((p) => before.strip.get(p.pool)!.names === after.strip.get(p.pool)?.names).map((p) => p.label).sort();
      const cardPins = await pins(card.stageId);
      expect(cardPins, `seed ${seed}: the card's Rebuild follows the rule (oracle sanity)`).toEqual(derived);
      // differential: today the strip keeps both pins.
      expect(await pins(strip.stageId), `seed ${seed}: the strip keeps exactly the card's pins`).toEqual(cardPins);
      const clearedByCard = cardOut.pins_cleared ?? 0;
      expect(clearedByCard, `seed ${seed}: the card cleared what the rule drops`).toBe(pinsBefore.length - derived.length);
      if (clearedByCard > 0) expect(stripOut.body.data?.pins_cleared, `seed ${seed}: the answer says how many went`).toBe(clearedByCard);
      else expect(stripOut.body.data, `seed ${seed}: none cleared, none said`).not.toHaveProperty("pins_cleared");
      kept += derived.length;
      dropped += pinsBefore.length - derived.length;
      checked++;
    }
    expect(checked).toBe(2);
    // Anti-vacuity: both answers occurred — a pin kept (seed 50's untouched pool) and a pin dropped.
    expect(kept, "a pin was kept somewhere").toBeGreaterThan(0);
    expect(dropped, "a pin was dropped somewhere").toBeGreaterThan(0);
  });

  it("m2 every waiting player is drawn in: the answer names them all, one ledger row each with their own lines", async () => {
    const r = await pinnedGroup();
    const ana = await arrive(r, "Ana Late", 50);
    const bo = await arrive(r, "Bo Late", 60);
    const out = await stripRebuild(r, bo);
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    expect(out.body.data).toMatchObject({ entrant_id: bo, reason: "rebuilt" });
    // The one pressed first, then every other waiter.
    expect(out.body.data?.drawn_in).toEqual([bo, ana]);
    const rows = await sql<{ payload: { entrant_id: string; case: string; fixture_ids: string[]; joined_round: number } }[]>`
      select payload from division_events where division_id = ${r.divisionId} and type = 'roundrobin_late_entry' order by seq`;
    expect(rows.map((x) => x.payload.entrant_id).sort(), "one ledger row per player drawn in").toEqual([ana, bo].sort());
    let checked = 0;
    for (const { payload } of rows) {
      const theirs = await sql<{ id: string }[]>`
        select id from fixtures where stage_id = ${r.stageId} and ${payload.entrant_id} in (home_entrant_id, away_entrant_id)`;
      expect(theirs.length, "premise: the redraw seated them").toBeGreaterThan(0);
      expect([...payload.fixture_ids].sort(), "the row carries that player's own lines").toEqual(theirs.map((t) => t.id).sort());
      expect(payload).toMatchObject({ case: "rebuilt", joined_round: 1 });
      checked++;
    }
    expect(checked).toBe(2);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from entrants where table_waiting_stage_id = ${r.stageId}`;
    expect(n, "nobody waits any more").toBe(0);
  });

  it("m2 the empty-other case: one waiting player is drawn in alone (drawn_in names only them, one ledger row)", async () => {
    const r = await pinnedGroup();
    const ana = await arrive(r, "Ana Late", 50);
    const out = await stripRebuild(r, ana);
    expect(out.status).toBe(200);
    expect(out.body.data?.drawn_in).toEqual([ana]);
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from division_events where division_id = ${r.divisionId} and type = 'roundrobin_late_entry'`;
    expect(n).toBe(1);
  });

  it("a second press after the redraw is refused by name (she no longer waits) and moves no pin", async () => {
    const r = await pinnedGroup();
    const ana = await arrive(r, "Ana Late", 50);
    expect((await stripRebuild(r, ana)).status).toBe(200);
    const pinsAfter = await pins(r.stageId);
    const again = await stripRebuild(r, ana);
    expect(again.status).toBe(409);
    expect(again.body.error?.code).toBe("RR_LATE_ENTRY_ALREADY_PLACED");
    expect(await pins(r.stageId)).toEqual(pinsAfter);
  });
});

/** The pins as the stage holds them before the redraw, each with its pool key (pins are written per pool, X-PO-3). */
async function pinsBeforeFromSeats(seats: Map<string, { ids: string[] }>): Promise<{ pool: string; label: string }[]> {
  const out: { pool: string; label: string }[] = [];
  for (const [pool, { ids }] of seats) {
    const [{ n }] = await sql<{ n: string }[]>`select display_name as n from entrants where id = ${ids[ids.length - 1]!}`;
    out.push({ pool, label: `${n}@1/${pool}` });
  }
  return out;
}
