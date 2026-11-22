// W5 stress fix F3: Reinstate voids a leaver's lines in ONE write.
//
// Before: a Reinstate (and the resume of a cut-off withdrawal, `takeBackLines`) voided each line's cascade events through its
// own `scoreEvent` — a transaction, a table refold, a discipline fold, a news probe, a public cache DEL and pushes, per line:
// 143 lines of a 144-entrant league were 2,711 transactions and 36 s (stress-report.md F3). After: every void goes in one
// transaction through the one append path (`appendEventInTx`), so each line keeps its own `core.void` row, and the
// after-commit work runs once.
//
// What this file pins, through the real doors (`withdrawEntrantCascade`, `patchEntrant` -> Reinstate) on a real database:
//   * the cost: each extra line costs at most two appends' worth of statements (one void through the append path, and as much
//     again for its share of the after-commit work), where the per-line `scoreEvent` cost many times that. The append's own
//     cost is MEASURED here, on the same rig, never typed;
//   * the sequence: expunge -> Reinstate -> a result -> withdraw again (now a walkover: she has played half) -> Reinstate, every
//     step read back from the ledger: each line gets exactly the voids it is owed, her removed results come back in order, the
//     opponents' results stand, and the standings rank her by her results again;
//   * the empty case and a retry: a leaver with no result in another sport (the registry's first team sport): only abandons to
//     void, nothing to re-record; a second Reinstate writes nothing.
//
// Expected counts are formulas over the field (n - 1 lines) or reads of the ledger BEFORE the withdrawal, never the
// Reinstate's own answer.
//
// Real Postgres; skipped without DATABASE_URL.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { builtinModules } from "@seazn/engine/sports";
import type { AnySportModule } from "@seazn/engine/sport";
import { sql, statementCount, withTenant } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { appendEventInTx } from "@/server/engine-db/append-event";
import { playBadminton } from "@/server/engine-db/__tests__/helpers/w2b-rig";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants, patchEntrant } from "../entrants";
import { startDivision } from "../schedule";
import { createStages } from "../stages";
import { withdrawEntrantCascade } from "../withdrawal";
import { voidLineEvents } from "../void-lines";
import { seedOrg } from "./_seed";

vi.mock("@/lib/posthog-server", () => ({ captureServer: vi.fn().mockResolvedValue(undefined) }));

const HAS_DB = !!process.env.DATABASE_URL;
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

type Kind = "individual" | "team";
const moduleOf = (key: string): AnySportModule => builtinModules.find((m) => m.key === key) as AnySportModule;
const variantOf = (key: string): string => Object.keys(moduleOf(key).variants)[0]!;
function teamSport(): string {
  const m = builtinModules.find((x) => x.entrantModel?.defaultKind === "team");
  if (m === undefined) throw new Error("premise: the registry declares a team sport");
  return m.key;
}

interface Rig {
  auth: AuthCtx;
  divisionId: string;
  stageId: string;
  /** P1, the one who leaves and comes back. */
  leaver: string;
  ids: string[];
}

async function league(n: number, sport = "badminton", kind: Kind = "individual", inOrg?: AuthCtx): Promise<Rig> {
  const { auth } = inOrg !== undefined ? { auth: inOrg } : await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "F3 " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const d = await createDivision(auth, comp.id, { name: "Open", slug: "f3-" + randomUUID().slice(0, 6), sport_key: sport, variant_key: variantOf(sport), config: {} });
  const es = await createEntrants(auth, d.id, Array.from({ length: n }, (_, i) => ({ kind, display_name: `P${i + 1}`, seed: i + 1, members: [] })) as never);
  const [stage] = await createStages(auth, d.id, { seq: 1, kind: "league", name: "Table", config: { legs: 1 }, progression: null });
  await startDivision(auth, d.id);
  return { auth, divisionId: d.id, stageId: stage!.id, leaver: es[0]!.id, ids: es.map((e) => e.id) };
}

interface Line {
  id: string;
  home_entrant_id: string;
  away_entrant_id: string;
}
const linesOf = (rig: Rig) =>
  sql<Line[]>`select id, home_entrant_id, away_entrant_id from fixtures where stage_id = ${rig.stageId} order by round_no, seq_in_round, id`;
const hers = async (rig: Rig) => (await linesOf(rig)).filter((l) => l.home_entrant_id === rig.leaver || l.away_entrant_id === rig.leaver);

interface Ev {
  id: string;
  seq: number;
  type: string;
  payload: unknown;
  voids_event_id: string | null;
  recorded_by: string | null;
}
const ledgerOf = (fixtureId: string) =>
  sql<Ev[]>`select id, seq, type, payload, voids_event_id, recorded_by from score_events where fixture_id = ${fixtureId} order by seq`;
/** A line's ACTIVE events (not voids, not voided), as type + payload: what its fold reads. */
async function activeOf(fixtureId: string): Promise<string[]> {
  const evs = await ledgerOf(fixtureId);
  const voided = new Set(evs.map((e) => e.voids_event_id).filter(Boolean));
  return evs.filter((e) => e.type !== "core.void" && !voided.has(e.id)).map((e) => `${e.type} ${JSON.stringify(e.payload)}`);
}
const statusOf = async (fixtureId: string) => (await sql<{ status: string }[]>`select status from fixtures where id = ${fixtureId}`)[0]!.status;

async function reinstate(rig: Rig) {
  const out = (await patchEntrant(rig.auth, rig.leaver, { status: "registered" } as never)) as { reinstate?: { voided: number; rerecorded: number; not_restored: string[] } };
  return out.reinstate;
}
async function postAt(auth: AuthCtx, fixtureId: string, type: string, payload: unknown = {}) {
  const [{ n }] = await sql<{ n: number }[]>`select coalesce(max(seq), 0)::int as n from score_events where fixture_id = ${fixtureId}`;
  const { scoreEvent } = await import("../scoring");
  return scoreEvent(auth, fixtureId, { expected_seq: n, type, payload } as never);
}
/** The stored table's row of each entrant (the refold the reverse owes). */
async function table(rig: Rig): Promise<Map<string, { played: number; won: number }>> {
  const rows = await sql<{ entrant_id: string; played: number; won: number }[]>`
    select (r->>'entrantId') as entrant_id, (r->>'played')::int as played, (r->>'won')::int as won
      from standings_snapshots s, jsonb_array_elements(s.rows) r where s.stage_id = ${rig.stageId}`;
  return new Map(rows.map((r) => [r.entrant_id, { played: r.played, won: r.won }]));
}

describe.skipIf(!HAS_DB)("F3: the cost of a Reinstate grows by one append per line, not one score write", () => {
  it("each extra line costs at most two appends' worth of statements (badminton, 6 vs 12 entrants, every line expunged)", async () => {
    // The append path's own cost for one void, measured on a rig of its own and rolled back.
    const probe = await league(3);
    await withdrawEntrantCascade(probe.auth, probe.leaver);
    const line = (await hers(probe))[0]!;
    const abandon = (await ledgerOf(line.id)).find((e) => e.type === "core.abandon")!;
    let perAppend = 0;
    await withTenant(probe.auth.orgId, async (tx) => {
      const tip = (await ledgerOf(line.id)).at(-1)!.seq;
      const before = statementCount();
      await appendEventInTx(tx, probe.auth.orgId, line.id, tip, {
        type: "core.void",
        payload: { event_id: abandon.id },
        voids: abandon.id,
        recordedBy: probe.auth.userId,
        writer: "withdrawal_cascade",
      });
      perAppend = statementCount() - before;
      throw new Error("rollback: measured only");
    }).catch((e: unknown) => {
      if (!String(e).includes("rollback: measured only")) throw e;
    });
    expect(perAppend, "anti-vacuity: the append path issues statements").toBeGreaterThan(0);

    const cost = async (n: number) => {
      const rig = await league(n);
      await withdrawEntrantCascade(rig.auth, rig.leaver);
      const before = statementCount();
      const out = await reinstate(rig);
      const spent = statementCount() - before;
      expect(out?.voided, "every line of hers had its expunge abandon voided (n - 1 lines)").toBe(n - 1);
      return spent;
    };
    const small = await cost(6);
    const large = await cost(12);
    const perLine = (large - small) / (11 - 5);
    expect(perLine, `statements per extra line (one append is ${perAppend})`).toBeLessThanOrEqual(2 * perAppend);
  });
});

describe.skipIf(!HAS_DB)("F3: expunge -> Reinstate -> result -> withdraw again -> Reinstate (badminton)", () => {
  it("each step leaves the ledger and the table it owes", async () => {
    const n = 6;
    const rig = await league(n);
    const mine = await hers(rig);
    expect(mine.length, "premise: n - 1 lines").toBe(n - 1);
    // She plays 2 of 5 (under half: an expunge, RB5-W2) and wins both; two opponents' own lines are played too.
    const played = mine.slice(0, 2);
    for (const l of played) await playBadminton(rig.auth, l.id, l.home_entrant_id === rig.leaver);
    const others = (await linesOf(rig)).filter((l) => !mine.some((m) => m.id === l.id)).slice(0, 2);
    for (const l of others) await playBadminton(rig.auth, l.id, true);
    const before = new Map(await Promise.all(mine.map(async (l) => [l.id, { active: await activeOf(l.id), status: await statusOf(l.id) }] as const)));
    const othersBefore = await Promise.all(others.map((l) => activeOf(l.id)));
    // What the expunge will remove and a Reinstate must put back: her played lines' active events other than the start (the
    // cascade's own reading, `activeResults`), counted from the ledger before she leaves.
    const owedBack = played.reduce((sum, l) => sum + before.get(l.id)!.active.filter((e) => !e.startsWith("core.start ")).length, 0);
    expect(owedBack, "anti-vacuity: there is something to put back").toBeGreaterThan(0);

    // 1. Withdraw: an expunge. Every line of hers abandoned, her results removed.
    const w1 = await withdrawEntrantCascade(rig.auth, rig.leaver);
    expect(w1.policy).toBe("expunge");
    for (const l of mine) expect(await statusOf(l.id), "expunged").toBe("abandoned");

    // 2. Reinstate: one void per line (its expunge abandon) and every removed result re-recorded, in order.
    const r1 = await reinstate(rig);
    expect(r1).toEqual({ voided: n - 1, rerecorded: owedBack, not_restored: [] });
    for (const l of mine) {
      expect(await activeOf(l.id), "the line reads as it did before she left").toEqual(before.get(l.id)!.active);
      expect(await statusOf(l.id)).toBe(before.get(l.id)!.status);
      const ledger = await ledgerOf(l.id);
      const abandons = ledger.filter((e) => e.type === "core.abandon");
      expect(abandons.length, "one expunge abandon").toBe(1);
      const voidsOfAbandon = ledger.filter((e) => e.type === "core.void" && e.voids_event_id === abandons[0]!.id);
      expect(voidsOfAbandon.length, "its own void row, exactly one").toBe(1);
      expect(voidsOfAbandon[0]!.recorded_by, "recorded by the organiser who reinstated").toBe(rig.auth.userId);
      expect(ledger.map((e) => e.seq), "the ledger stays gapless").toEqual(ledger.map((_, i) => i + 1));
    }
    expect(await Promise.all(others.map((l) => activeOf(l.id))), "the opponents' own results stand").toEqual(othersBefore);
    const t1 = await table(rig);
    expect(t1.size, "the refolded table holds the whole field").toBe(n);
    expect(t1.get(rig.leaver), "her two results count again: played 2, won 2").toEqual({ played: 2, won: 2 });

    // 3. A result on one of her unplayed lines, from the ledger's tip.
    const third = mine[2]!;
    await postAt(rig.auth, third.id, "core.start");
    for (let g = 0; g < 2; g++) await postAt(rig.auth, third.id, "badminton.game.summary", third.home_entrant_id === rig.leaver ? { home: 21, away: 5 } : { home: 5, away: 21 });
    expect(await statusOf(third.id)).toBe("decided");

    // 4. Withdraw again: 3 of 5 played (half or more) is a walkover (RB5-W3): her two unplayed lines walked over, results stand.
    const w2 = await withdrawEntrantCascade(rig.auth, rig.leaver);
    expect(w2.policy).toBe("walkover");
    const unplayed = mine.slice(3);
    for (const l of unplayed) expect(await statusOf(l.id), "walked over").toBe("forfeited");

    // 5. Reinstate again: exactly her walkovers voided, nothing to re-record; the lines are owed again.
    const r2 = await reinstate(rig);
    expect(r2).toEqual({ voided: unplayed.length, rerecorded: 0, not_restored: [] });
    for (const l of unplayed) {
      expect(await statusOf(l.id)).toBe("scheduled");
      expect(await activeOf(l.id), "no active event on a line owed again").toEqual([]);
    }
    for (const l of mine.slice(0, 3)) expect(await statusOf(l.id), "her three results stand").toBe("decided");
  });
});

describe.skipIf(!HAS_DB)("F3: the empty case and a retry, in another sport", () => {
  it("the first team sport: a leaver with no result has only abandons voided; a second Reinstate writes nothing", async () => {
    const n = 5;
    const rig = await league(n, teamSport(), "team");
    const mine = await hers(rig);
    await withdrawEntrantCascade(rig.auth, rig.leaver);
    for (const l of mine) expect(await statusOf(l.id)).toBe("abandoned");
    const r1 = await reinstate(rig);
    expect(r1).toEqual({ voided: n - 1, rerecorded: 0, not_restored: [] });
    for (const l of mine) {
      expect(await statusOf(l.id)).toBe("scheduled");
      expect(await activeOf(l.id)).toEqual([]);
    }
    const voidRows = async () => (await Promise.all(mine.map(async (l) => (await ledgerOf(l.id)).filter((e) => e.type === "core.void").length))).reduce((a, b) => a + b, 0);
    const voidsAfterFirst = await voidRows();
    expect(voidsAfterFirst, "one void row per line").toBe(n - 1);
    // A retry (a status re-asserted over her departed one is the only door to a Reinstate): withdraw is not re-run here; the
    // reverse itself is asked again through its own door and must write nothing twice.
    const { reinstateTableEntrant } = await import("../withdrawal");
    const again = await reinstateTableEntrant(rig.auth, rig.leaver);
    expect(again).toEqual({ voided: 0, rerecorded: 0, not_restored: [] });
    expect(await voidRows(), "no second void").toBe(voidsAfterFirst);
  });
});

describe.skipIf(!HAS_DB)("F3: voidLineEvents' own guards (assumptions it writes under, each refused by name, nothing written)", () => {
  /** A started league with one expunged-then-abandoned line: P1's withdrawal under half played (RB5-W2). */
  async function expunged() {
    const rig = await league(4);
    await withdrawEntrantCascade(rig.auth, rig.leaver);
    const [line, other] = await hers(rig);
    const abandon = (await ledgerOf(line!.id)).find((e) => e.type === "core.abandon")!;
    return { rig, line: line!, other: other!, abandon };
  }
  const voidsOn = async (id: string) => (await ledgerOf(id)).filter((e) => e.type === "core.void").length;

  it("the empty case: no voids and nothing else to write sends no statement", async () => {
    const { rig } = await expunged();
    const before = statementCount();
    expect(await voidLineEvents(rig.auth, rig.divisionId, [], { writer: "withdrawal_cascade" })).toEqual([]);
    expect(statementCount() - before).toBe(0);
  });

  it("a target already voided is skipped: the second batch writes nothing, the line holds one void", async () => {
    const { rig, line, abandon } = await expunged();
    const v = [{ fixtureId: line.id, eventId: abandon.id }];
    expect(await voidLineEvents(rig.auth, rig.divisionId, v, { writer: "withdrawal_cascade" })).toEqual([line.id]);
    expect(await voidLineEvents(rig.auth, rig.divisionId, v, { writer: "withdrawal_cascade" })).toEqual([]);
    expect(await voidsOn(line.id)).toBe(1);
  });

  it("an event that is not the named line's is refused, and the batch's other void rolls back with it", async () => {
    const { rig, line, other, abandon } = await expunged();
    const otherAbandon = (await ledgerOf(other.id)).find((e) => e.type === "core.abandon")!;
    const v = [
      { fixtureId: other.id, eventId: otherAbandon.id },
      { fixtureId: line.id, eventId: otherAbandon.id }, // the other line's abandon, named as this line's
    ];
    await expect(voidLineEvents(rig.auth, rig.divisionId, v, { writer: "withdrawal_cascade" })).rejects.toThrow(/is not line .*'s/);
    expect([await voidsOn(line.id), await voidsOn(other.id)], "nothing of the batch stands").toEqual([0, 0]);
    expect(abandon.id).not.toBe(otherAbandon.id);
  });

  it("a line of another division is refused", async () => {
    const a = await expunged();
    const b = await league(3, "badminton", "individual", a.rig.auth); // same org: only the division differs
    await expect(
      voidLineEvents(a.rig.auth, b.divisionId, [{ fixtureId: a.line.id, eventId: a.abandon.id }], { writer: "withdrawal_cascade" }),
    ).rejects.toThrow(/is not division .*'s/);
    expect(await voidsOn(a.line.id)).toBe(0);
  });

  it("a line that FEEDS a match (a knockout's) is refused: its void would take the stage lock after its fixture lock", async () => {
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "F3 ko " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
    const d = await createDivision(auth, comp.id, { name: "Cup", slug: "f3k-" + randomUUID().slice(0, 6), sport_key: "badminton", variant_key: variantOf("badminton"), config: {} });
    await createEntrants(auth, d.id, Array.from({ length: 4 }, (_, i) => ({ kind: "individual", display_name: `K${i + 1}`, seed: i + 1, members: [] })) as never);
    const [stage] = await createStages(auth, d.id, { seq: 1, kind: "knockout", name: "Cup", config: {}, progression: null });
    await startDivision(auth, d.id);
    const [semi] = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${stage!.id} and winner_to_fixture is not null order by id limit 1`;
    expect(semi, "premise: a 4-draw knockout's semi feeds the final").toBeDefined();
    await postAt(auth, semi!.id, "core.start");
    const started = (await ledgerOf(semi!.id)).at(-1)!;
    await expect(
      voidLineEvents(auth, d.id, [{ fixtureId: semi!.id, eventId: started.id }], { writer: "withdrawal_cascade" }),
    ).rejects.toThrow(/feeds another match/);
    expect(await voidsOn(semi!.id)).toBe(0);
  });

  it("a division whose scoring is closed is refused WRONG_PHASE, as the scoring door refuses it", async () => {
    const { rig, line, abandon } = await expunged();
    await sql`update divisions set status = 'scheduled' where id = ${rig.divisionId}`;
    await expect(
      voidLineEvents(rig.auth, rig.divisionId, [{ fixtureId: line.id, eventId: abandon.id }], { writer: "withdrawal_cascade" }),
    ).rejects.toMatchObject({ code: "WRONG_PHASE" });
    expect(await voidsOn(line.id)).toBe(0);
  });
});
