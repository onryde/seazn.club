// W5 app PR A, Task 8 (ST-G15 app half; X-WDT-5, X-WDT-7, X-WDT-8; RB5-W1..W7, W12; ruling 105 guard) — a league or group
// withdrawal, driven through the real doors (`withdrawEntrantCascade`, `patchEntrant`'s disqualify and Reinstate, the scoring
// door for results) on a real database, read back from the stored rows, the score ledger and the division ledger.
//
// Expected values: the rule is the rulebook's (RB5-W2 under half: every result removed, finalized included, the rest voided;
// RB5-W3 half or more: results stand, the rest walk over; RB5-W4 the count; RB5-W6 Reinstate; RB5-W7 the footnote), the walkover
// credit is the sport module's own declaration (`forfeitCredit`), and every count is read from the rows, never from the cascade's
// report. Sports: badminton (BWF), a sweep of the registry for the walkover score, tennis and badminton for ruling 290, football
// for a team table, and a badminton pair.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { isReversible } from "@seazn/engine/history";
import { builtinModules } from "@seazn/engine/sports";
import type { AnySportModule } from "@seazn/engine/sport";
import { forEachSportAsync } from "@seazn/engine/testkit";
import enPublic from "@/dictionaries/en/public.json";
import { sql } from "@/lib/db";
import { reinstateReplyNotice } from "@/lib/swiss-late-entry-notice";
import { PatchedEntrant } from "@/server/api-v1/schemas";
import type { AuthCtx } from "@/server/api-v1/auth";
import { playBadminton, post, tip } from "@/server/engine-db/__tests__/helpers/w2b-rig";
import { createCompetition } from "../competitions";
import { createDivision, patchDivision } from "../divisions";
import { createEntrants, patchEntrant, writeEntrantPatch } from "../entrants";
import { getFixtureState } from "../fixtures";
import { divisionHistory, undoBarrierRefusal } from "../history";
import { startDivision } from "../schedule";
import { finalizeFixture, scoreEvent } from "../scoring";
import { addFixture, completeStage, createStages, getStandings, refoldStageTable } from "../stages";
import { reinstateTableEntrant, withdrawEntrantCascade } from "../withdrawal";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

type Kind = "individual" | "pair" | "team";
const moduleOf = (key: string): AnySportModule => builtinModules.find((m) => m.key === key) as AnySportModule;
const variantOf = (key: string): string => Object.keys(moduleOf(key).variants)[0]!;

interface Line {
  id: string;
  ext_key: string | null;
  round_no: number;
  pool_id: string | null;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
  outcome: { kind?: string; winner?: string; loser?: string | null; reason?: string } | null;
}
const linesOf = (stageId: string) =>
  sql<Line[]>`
    select id, ext_key, round_no, pool_id, home_entrant_id, away_entrant_id, status, outcome
      from fixtures where stage_id = ${stageId} order by round_no, seq_in_round, id`;
const lineOf = async (id: string) => (await sql<Line[]>`select id, ext_key, round_no, pool_id, home_entrant_id, away_entrant_id, status, outcome from fixtures where id = ${id}`)[0]!;
const sides = (l: Line) => [l.home_entrant_id, l.away_entrant_id];
const involves = (l: Line, e: string) => l.home_entrant_id === e || l.away_entrant_id === e;

interface Ev {
  id: string;
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  voids_event_id: string | null;
}
const ledgerOf = (fixtureId: string) =>
  sql<Ev[]>`select id, seq, type, payload, voids_event_id from score_events where fixture_id = ${fixtureId} order by seq`;
/** The events the fold reads: neither a void nor voided (voids are not voidable). */
async function activeEvents(fixtureId: string): Promise<Ev[]> {
  const evs = await ledgerOf(fixtureId);
  const voided = new Set(evs.filter((e) => e.voids_event_id !== null).map((e) => e.voids_event_id));
  return evs.filter((e) => e.type !== "core.void" && !voided.has(e.id));
}
const hasActiveExpunge = async (fixtureId: string) =>
  (await activeEvents(fixtureId)).some((e) => e.type === "core.abandon" && e.payload.expunge === true);

/** The division ledger's table-withdrawal rows, raw (the footnote's source, RB5-W7). */
const withdrawalRows = (divisionId: string) =>
  sql<{ seq: number; type: string; payload: Record<string, unknown> }[]>`
    select seq::int as seq, type, payload from division_events
     where division_id = ${divisionId} and type in ('table_withdrawal', 'table_withdrawal_voided') order by seq`;

interface Rig {
  auth: AuthCtx;
  divisionId: string;
  stageId: string;
  id: Map<string, string>;
}

/** `n` seeded entrants P1..Pn in one root league (or a group of `pools`), started. */
async function started(
  n: number,
  opts: { sport?: string; variant?: string; kind?: Kind; people?: number; group?: { pools: number }; knockout?: boolean } = {},
): Promise<Rig> {
  const sport = opts.sport ?? "badminton";
  const kind = opts.kind ?? ((moduleOf(sport).entrantModel?.defaultKind ?? "individual") as Kind);
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "W5 T8 " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const d = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "o-" + randomUUID().slice(0, 6),
    sport_key: sport,
    variant_key: opts.variant ?? variantOf(sport),
    config: {},
  });
  const es = await createEntrants(
    auth,
    d.id,
    Array.from({ length: n }, (_, i) => ({
      kind,
      display_name: `P${i + 1}`,
      seed: i + 1,
      members: Array.from({ length: opts.people ?? 0 }, (_, j) => ({
        new_person: { full_name: `P${i + 1} ${j} ${randomUUID().slice(0, 6)}` },
        is_captain: false,
        roles: [] as string[],
      })),
    })) as never,
  );
  const stage = opts.group
    ? { seq: 1, kind: "group" as const, name: "Groups", config: { groups: opts.group.pools }, progression: null }
    : { seq: 1, kind: "league" as const, name: "Table", config: { legs: 1 }, progression: null };
  const stages = opts.knockout
    ? [
        stage,
        {
          seq: 2,
          kind: "knockout" as const,
          name: "Final",
          config: {},
          progression: { sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] }], placement: "rank_order", timing: "on_complete" },
        },
      ]
    : [stage];
  if (opts.knockout) await patchDivision(auth, d.id, { auto_progress: true });
  const [s] = await createStages(auth, d.id, stages as never);
  await startDivision(auth, d.id);
  return { auth, divisionId: d.id, stageId: s!.id, id: new Map(es.map((e) => [e.display_name, e.id])) };
}

/** An ordinary walkover (not a withdrawal): `loser` did not turn up. A recorded result for every sport (pre phase, any
 *  module), which RB5-W4 counts as played. */
async function walkoverAgainst(auth: AuthCtx, fixtureId: string, loser: string): Promise<void> {
  const out = await post(auth, fixtureId, "core.forfeit", { by: loser, reason: "walkover" });
  expect(out.status, "rig: an ordinary walkover is a recorded result").toBe("forfeited");
}

/** The line between two entrants (one leg). */
async function lineBetween(stageId: string, a: string, b: string): Promise<Line> {
  const l = (await linesOf(stageId)).find((x) => involves(x, a) && involves(x, b));
  if (l === undefined) throw new Error("rig: no line between the two");
  return l;
}

async function standingsRows(auth: AuthCtx, stageId: string, poolId?: string) {
  return (await getStandings(auth, stageId, poolId)).rows as { entrantId: string; played: number; points: number; rank?: number; metrics: Record<string, number> }[];
}
const playedOf = async (auth: AuthCtx, stageId: string) =>
  Object.fromEntries((await standingsRows(auth, stageId)).map((r) => [r.entrantId, r.played]));

/** A line as the table and the score ledger see it: its status, its outcome, and its ACTIVE events (type and payload, in
 *  order) — what a Reinstate must give back, captured BEFORE the withdrawal (never derived from the code under test). */
async function lineState(fixtureId: string) {
  const l = await lineOf(fixtureId);
  return { status: l.status, outcome: l.outcome, events: (await activeEvents(fixtureId)).map((e) => [e.type, JSON.stringify(e.payload)]) };
}

const statusOf = async (entrantId: string) =>
  (await sql<{ status: string; table_waiting_stage_id: string | null }[]>`select status, table_waiting_stage_id from entrants where id = ${entrantId}`)[0]!;

describe.skipIf(!HAS_DB)("X-WDT-5 (RB5-W2): under half played, every result is removed — finalized ones included", () => {
  it("X-WDT-5 under half played with a finalized result: the finalized result is removed too", async () => {
    const r = await started(4);
    const [p1, p2] = [r.id.get("P1")!, r.id.get("P2")!];
    const signed = await lineBetween(r.stageId, p1, p2);
    await playBadminton(r.auth, signed.id, signed.home_entrant_id === p2);
    await finalizeFixture(r.auth, signed.id, await tip(signed.id));
    expect((await lineOf(signed.id)).status, "rig: P2 beat P1 and the result is signed off").toBe("finalized");
    // The table BEFORE, from the real fold: P2 has one match counted.
    expect((await playedOf(r.auth, r.stageId))[p2], "rig: before, P2 has played one").toBe(1);

    // RB5-W2: P1 has played 1 of 3 — under half — so every result P1 played is removed and the rest voided.
    // differential: today it stays (withdrawal.ts:232 skips a finalized fixture; the cascade reports skipped_finalized: 1).
    const out = await withdrawEntrantCascade(r.auth, p1);
    expect(out).toMatchObject({ policy: "expunge", voided: 3, walkovers: 0, skipped_cancelled: 0 });
    const mine = (await linesOf(r.stageId)).filter((l) => involves(l, p1));
    expect(mine, "P1's three lines").toHaveLength(3);
    for (const l of mine) {
      expect([l.status, l.outcome, await hasActiveExpunge(l.id)], `line ${l.ext_key}: removed by the expunge abandon`).toEqual(["abandoned", null, true]);
    }
    const types = (await activeEvents(signed.id)).map((e) => e.type);
    expect(types, "the signed-off line holds no finalize and no result any more").not.toContain("core.finalize");
    expect(types.filter((t) => t.startsWith("badminton.")), "no game left standing").toEqual([]);
    // The table AFTER: the removed result counts for nobody.
    const after = await playedOf(r.auth, r.stageId);
    expect(after[p2], "P2's win over the leaver is gone").toBe(0);
    expect(after[p1], "the leaver's row is present and counts nothing").toBe(0);
  }, 120_000);

  // The ledger's finalized lock (append-event.ts) is opened for ONE write only: the cascade's void of the active finalize.
  // Each refusal below is a different arm of `cascadeReopensFinalize`; the last is the positive pair (the cascade's own void).
  it("the finalized lock opens for the cascade's void of the finalize, and for nothing else", async () => {
    const r = await started(4);
    const [p1, p2] = [r.id.get("P1")!, r.id.get("P2")!];
    const signed = await lineBetween(r.stageId, p1, p2);
    await playBadminton(r.auth, signed.id, true);
    await finalizeFixture(r.auth, signed.id, await tip(signed.id));
    const evs = await activeEvents(signed.id);
    const fin = evs.find((e) => e.type === "core.finalize")!;
    const game = evs.find((e) => e.type.startsWith("badminton."))!;
    expect([fin, game].every(Boolean), "rig: a finalize and a game on the ledger").toBe(true);
    const voidOf = async (id: string, opts?: { writer: "withdrawal_cascade" }) =>
      scoreEvent(r.auth, signed.id, { expected_seq: await tip(signed.id), type: "core.void", payload: { event_id: id } }, opts);
    await expect(voidOf(fin.id), "an organiser's void of the finalize").rejects.toMatchObject({ code: "ALREADY_DECIDED" });
    await expect(voidOf(game.id, { writer: "withdrawal_cascade" }), "the cascade voiding anything but the finalize").rejects.toMatchObject({ code: "ALREADY_DECIDED" });
    await expect(
      scoreEvent(r.auth, signed.id, { expected_seq: await tip(signed.id), type: "core.abandon", payload: { expunge: true, reason: "withdrew" } }, { writer: "withdrawal_cascade" }),
      "the cascade's abandon before the finalize is voided",
    ).rejects.toMatchObject({ code: "ALREADY_DECIDED" });
    expect((await lineOf(signed.id)).status, "every refusal left it signed off").toBe("finalized");
    await voidOf(fin.id, { writer: "withdrawal_cascade" });
    expect((await lineOf(signed.id)).status, "the positive pair: the cascade's void of the finalize reopens it").not.toBe("finalized");
  }, 120_000);

  it("a cancelled line is still left as it is, and counted", async () => {
    const r = await started(4);
    const p1 = r.id.get("P1")!;
    const [gone] = (await linesOf(r.stageId)).filter((l) => involves(l, p1));
    // No product write sets `cancelled` (auto-advance-finished.test.ts's own note), so the rig writes it as a staff fix would.
    await sql`update fixtures set status = 'cancelled' where id = ${gone!.id}`;
    const out = await withdrawEntrantCascade(r.auth, p1);
    expect(out).toMatchObject({ policy: "expunge", voided: 2, skipped_cancelled: 1 });
    expect((await lineOf(gone!.id)).status, "the cancelled line is untouched").toBe("cancelled");
    // RB5-W4: a cancelled line is not one of her scheduled matches.
    expect((await withdrawalRows(r.divisionId)).map((x) => x.payload.scheduled)).toEqual([2]);
  }, 120_000);
});

describe.skipIf(!HAS_DB)("X-WDT-5 (RB5-W3): half or more played, results stand and the rest walk over at the sport's score", () => {
  it("X-WDT-5 half or more: results stand, the rest walk over at the sport's score — every sport", async () => {
    // pin, no defect expected: the walkover itself is W2's; this sweeps every module's declared credit through the table.
    let compared = 0;
    const visited = await forEachSportAsync(async ({ key, module: m }) => {
      if (key === "generic") return; // no catalogue variant a division can be created on without the seeded score variant
      const r = await started(3, { sport: key });
      const [l, a, b] = [r.id.get("P1")!, r.id.get("P2")!, r.id.get("P3")!];
      const first = await lineBetween(r.stageId, l, a);
      await walkoverAgainst(r.auth, first.id, a); // the leaver has a result: 1 of 2 played, half
      const out = await withdrawEntrantCascade(r.auth, l);
      expect(out, `${key}: half played, so a walkover`).toMatchObject({ policy: "walkover", walkovers: 1, voided: 0 });
      expect((await lineOf(first.id)).outcome, `${key}: the leaver's played result stands`).toMatchObject({ kind: "award", winner: l });
      const owed = await lineBetween(r.stageId, l, b);
      expect(owed.outcome, `${key}: the unplayed line is B's walkover`).toMatchObject({ kind: "award", winner: b, loser: l, reason: "withdrew" });
      // The sport's declared credit (`forfeitCredit`, by = the OFFENDING side), from the line's own fold.
      const cfg = m.configSchema.parse(m.variants[variantOf(key)]);
      const { state } = await getFixtureState(r.auth, owed.id);
      const offender = owed.home_entrant_id === l ? "home" : "away";
      const credit = m.forfeitCredit(cfg as never, state as never, "withdrew", offender);
      const bSide = credit.perSide[offender === "home" ? 1 : 0];
      const row = (await standingsRows(r.auth, r.stageId)).find((x) => x.entrantId === b)!;
      for (const [metric, value] of Object.entries(bSide)) {
        if (credit.excluded.includes(metric) || !Object.hasOwn(row.metrics, metric)) continue;
        expect(row.metrics[metric], `${key}: B's ${metric} is the sport's walkover credit`).toBe(value);
        compared++;
      }
    });
    expect(visited, "the registry sweep visited every sport").toBe(builtinModules.length);
    expect(compared, "metrics compared against a declared credit").toBeGreaterThan(0);
  }, 600_000);
});

describe.skipIf(!HAS_DB)("X-WDT-5 (RB5-W4, RB5-W7): the ledger row the footnote reads", () => {
  it("X-WDT-5 the footnote names the rule: one table_withdrawal row with the real count", async () => {
    // differential: today no row (and no footnote) — the cascade writes nothing to the division ledger.
    const r = await started(4);
    const [p1, p2, p3] = [r.id.get("P1")!, r.id.get("P2")!, r.id.get("P3")!];
    await walkoverAgainst(r.auth, (await lineBetween(r.stageId, p1, p2)).id, p2);
    await walkoverAgainst(r.auth, (await lineBetween(r.stageId, p1, p3)).id, p3);
    await withdrawEntrantCascade(r.auth, p1);
    const rows = await withdrawalRows(r.divisionId);
    expect(rows.map((x) => [x.type, x.payload])).toEqual([
      ["table_withdrawal", { entrant_id: p1, stage_id: r.stageId, policy: "walkover", played_at_departure: 2, scheduled: 3, pool_id: null }],
    ]);
    const { loadTableWithdrawals } = await import("@/server/public-site/table-withdrawals");
    const { withdrawalNotesFor, withdrawalNoteText } = await import("@/lib/table-withdrawal-note");
    const records = await loadTableWithdrawals(r.divisionId);
    const notes = withdrawalNotesFor(r.stageId, [p1, p2, p3, r.id.get("P4")!], records, { [p1]: "withdrawn" }, { [p1]: "P1" }, null);
    const { WithdrawalFootnotes } = await import("@/components/public-site/withdrawal-footnotes");
    const html = renderToStaticMarkup(
      createElement(WithdrawalFootnotes, { items: notes.map((n) => withdrawalNoteText(n, (k, v) => interpolate(enPublic as Record<string, string>, k, v))) }),
    );
    expect(text(html)).toBe("P1 (withdrawn): left after 2 of 3, so their results stand and their other match is a walkover.");
  }, 120_000);

  it("X-WDT-5 scheduled counts catch-up lines (RB5-W4): a withdrawal after a late entry", async () => {
    const r = await started(4);
    const [late] = await createEntrants(r.auth, r.divisionId, [{ kind: "individual", display_name: "Late", seed: null, members: [] }] as never);
    const n = late!.id;
    const hers = (await linesOf(r.stageId)).filter((l) => involves(l, n));
    // The oracle is the stored rows: every line seating her, catch-up ones included (RB5-W4 counts every leg's fixtures).
    expect(hers.length, "rig: the late entrant owes a line against each of four").toBe(4);
    expect(hers.filter((l) => /(^|-)rr-(cu|by)-/.test(l.ext_key ?? "")).length, "rig: at least one is a catch-up line").toBeGreaterThan(0);
    await withdrawEntrantCascade(r.auth, n);
    const rows = await withdrawalRows(r.divisionId);
    expect(rows.map((x) => x.payload)).toEqual([{ entrant_id: n, stage_id: r.stageId, policy: "expunge", played_at_departure: 0, scheduled: hers.length, pool_id: null }]);
    for (const l of hers) expect(await hasActiveExpunge(l.id), `catch-up line ${l.ext_key} expunged`).toBe(true);
  }, 120_000);
});

describe.skipIf(!HAS_DB)("X-WDT-7 (RB5-W1, RB5-W5): the leaver stays in the table, marked, ranked last", () => {
  async function leaverWithTheMostPoints(as: "withdrawn" | "disqualified") {
    // 4 in a league; the leaver wins 2 of 3 (two ordinary walkovers in her favour), so she tops the table on points before
    // she leaves — "ranked last" then differs from "ranked by points".
    const r = await started(4);
    const [p1, p2, p3, p4] = ["P1", "P2", "P3", "P4"].map((k) => r.id.get(k)!) as [string, string, string, string];
    await walkoverAgainst(r.auth, (await lineBetween(r.stageId, p1, p2)).id, p2);
    await walkoverAgainst(r.auth, (await lineBetween(r.stageId, p1, p3)).id, p3);
    const before = await standingsRows(r.auth, r.stageId);
    expect(before.find((x) => x.entrantId === p1)!.rank, "rig: the leaver tops the table before she leaves").toBe(1);
    if (as === "withdrawn") await withdrawEntrantCascade(r.auth, p1);
    else await patchEntrant(r.auth, p1, { status: "disqualified" });
    expect((await statusOf(p1)).status).toBe(as);
    const rows = await standingsRows(r.auth, r.stageId);
    expect(rows.map((x) => x.entrantId).sort(), "four rows: she stays in the table").toEqual([p1, p2, p3, p4].sort());
    const ranks = rows.map((x) => x.rank ?? 0);
    expect(rows.find((x) => x.entrantId === p1)!.rank, `${as}: ranked last`).toBe(Math.max(...ranks));
    const held = await withdrawalRows(r.divisionId);
    expect(held.map((x) => x.payload.policy), `${as}: the same rule as a withdrawal (2 of 3: walkover)`).toEqual(["walkover"]);
  }

  it("X-WDT-7 a league leaver stays in the table, marked, ranked last", () => leaverWithTheMostPoints("withdrawn"), 120_000);
  it("X-WDT-7 a disqualification follows the same rule", () => leaverWithTheMostPoints("disqualified"), 120_000);

  // Fix round 1 (C1, RB5-L8): a league that FINISHED is never re-ranked by a later departure from another stage. The league
  // winner, seeded into the final, withdraws there: the finished table keeps her first, takes no row and no footnote, and a
  // later refold of it (any result anywhere) still reads her as earned. The positive pair is the running table above (she
  // ranks last). differential: before the fix the finished league went 1st → 4th with a footnote.
  it("X-WDT-7 a finished table is never re-ranked by a withdrawal from the knockout after it", async () => {
    const r = await started(4, { knockout: true });
    const order = ["P1", "P2", "P3", "P4"].map((k) => r.id.get(k)!);
    for (const l of await linesOf(r.stageId)) {
      const loser = order.indexOf(l.home_entrant_id!) > order.indexOf(l.away_entrant_id!) ? l.home_entrant_id! : l.away_entrant_id!;
      await walkoverAgainst(r.auth, l.id, loser);
    }
    const [st] = await sql<{ status: string }[]>`select status from stages where id = ${r.stageId}`;
    expect(st!.status, "rig: the league finished").toBe("complete");
    const [ko] = await sql<{ id: string }[]>`select id from stages where division_id = ${r.divisionId} and kind = 'knockout'`;
    const final = await sql<{ id: string; home_entrant_id: string | null; away_entrant_id: string | null }[]>`
      select id, home_entrant_id, away_entrant_id from fixtures where stage_id = ${ko!.id}`;
    expect(final.flatMap((f) => [f.home_entrant_id, f.away_entrant_id]), "rig: P1 is seeded into the final").toContain(order[0]);
    const ranks = async () => (await standingsRows(r.auth, r.stageId)).map((x) => [x.entrantId, x.rank, x.points]);
    const before = await ranks();
    expect(before[0]![0], "rig: P1 topped the league").toBe(order[0]);
    const snap = async () => (await sql<{ rows: unknown }[]>`select rows from standings_snapshots where stage_id = ${r.stageId} order by pool_id nulls first`).map((x) => JSON.stringify(x.rows));
    const snapBefore = await snap();

    await withdrawEntrantCascade(r.auth, order[0]!);
    expect(await ranks(), "the finished league is not re-ranked").toEqual(before);
    expect(await snap(), "its stored snapshot is untouched").toEqual(snapBefore);
    expect(await withdrawalRows(r.divisionId), "no table_withdrawal row: no footnote").toEqual([]);
    await refoldStageTable(r.auth.orgId, { id: r.stageId, kind: "league" }, "skip");
    expect(await ranks(), "a later refold reads her as earned, not departed").toEqual(before);
  }, 180_000);

  it("X-WDT-7 a pooled leaver stays in their pool's table", async () => {
    const r = await started(6, { group: { pools: 2 } });
    const p1 = r.id.get("P1")!;
    const [mine] = (await linesOf(r.stageId)).filter((l) => involves(l, p1));
    const pool = mine!.pool_id!;
    await withdrawEntrantCascade(r.auth, p1);
    const rows = await standingsRows(r.auth, r.stageId, pool);
    expect(rows.map((x) => x.entrantId), "her pool's table still lists her").toContain(p1);
  }, 120_000);
});

describe.skipIf(!HAS_DB)("X-WDT-7 (ruling 290): tennis and badminton follow ruling 277, no sport-specific code", () => {
  // differential: none expected — the app has no sport-specific withdrawal code; this pins that.
  async function sixLeague(sport: string, played: number) {
    const r = await started(6, { sport });
    const p1 = r.id.get("P1")!;
    const others = ["P2", "P3", "P4", "P5", "P6"].map((k) => r.id.get(k)!);
    for (const o of others.slice(0, played)) await walkoverAgainst(r.auth, (await lineBetween(r.stageId, p1, o)).id, o);
    const out = await withdrawEntrantCascade(r.auth, p1);
    return { r, p1, others, out };
  }

  it("X-WDT-7 a tennis league withdrawal follows ruling 277", async () => {
    const two = await sixLeague("tennis", 2);
    expect(two.out, "2 of 5: expunge").toMatchObject({ policy: "expunge", voided: 5, walkovers: 0 });
    const three = await sixLeague("tennis", 3);
    expect(three.out, "3 of 5: results stand, the rest walk over").toMatchObject({ policy: "walkover", walkovers: 2, voided: 0 });
    for (const o of three.others.slice(3)) {
      expect((await lineBetween(three.r.stageId, three.p1, o)).outcome).toMatchObject({ kind: "award", winner: o, reason: "withdrew" });
    }
  }, 240_000);

  it("X-WDT-7 a badminton league withdrawal follows ruling 277, not BWF GCR 16.2.5's delete-all", async () => {
    // BD-WO-2 / BD-RT-1 as re-worded (ruling 290): the recorded deviation — 3 of 5 played, every result stands.
    const three = await sixLeague("badminton", 3);
    expect(three.out).toMatchObject({ policy: "walkover", walkovers: 2, voided: 0 });
    for (const o of three.others.slice(0, 3)) {
      const l = await lineBetween(three.r.stageId, three.p1, o);
      expect([l.status, l.outcome?.winner], "a played result stands").toEqual(["forfeited", three.p1]);
    }
  }, 240_000);
});

describe.skipIf(!HAS_DB)("X-WDT-8 (RB5-W6): Reinstate reverses the expunge or the walkovers", () => {
  // Fix round 1 (I1): the removed result comes BACK. A void is not voidable, so the Reinstate re-records what the expunge voided
  // (engine events.js:354-357), and the signed-off line is signed off again. Expected: the state captured before the withdrawal.
  // differential: before the fix the line was left `in_play` with no result (the expunge's voids stood).
  it("X-WDT-8 Reinstate reverses the expunge: the removed result is re-recorded, signed off again", async () => {
    const r = await started(4);
    const [p1, p2] = [r.id.get("P1")!, r.id.get("P2")!];
    const signed = await lineBetween(r.stageId, p1, p2);
    await playBadminton(r.auth, signed.id, signed.home_entrant_id === p2);
    await finalizeFixture(r.auth, signed.id, await tip(signed.id));
    const pre = Object.fromEntries(await Promise.all((await linesOf(r.stageId)).filter((l) => involves(l, p1)).map(async (l) => [l.id, await lineState(l.id)] as const)));
    const preTable = Object.fromEntries((await standingsRows(r.auth, r.stageId)).map((x) => [x.entrantId, [x.played, x.points]]));
    expect(pre[signed.id]!.status, "rig: signed off").toBe("finalized");
    expect(pre[signed.id]!.events.length, "rig: a played result on the ledger").toBeGreaterThan(2);
    await withdrawEntrantCascade(r.auth, p1);
    expect((await lineOf(signed.id)).status, "rig: the expunge removed it").toBe("abandoned");
    await patchEntrant(r.auth, p1, { status: "registered" });
    const me = await statusOf(p1);
    // Task 6's door: her lines still exist, so she never waits for a place.
    expect([me.status, me.table_waiting_stage_id], "back in the field, not waiting").toEqual(["registered", null]);
    const mine = (await linesOf(r.stageId)).filter((l) => involves(l, p1));
    expect(mine.map((l) => l.id).sort(), "her three lines, never reshaped").toEqual(Object.keys(pre).sort());
    let checked = 0;
    for (const l of mine) {
      expect(await lineState(l.id), `line ${l.ext_key}: exactly as before the withdrawal`).toEqual(pre[l.id]);
      checked++;
    }
    expect(checked).toBe(3);
    const table = Object.fromEntries((await standingsRows(r.auth, r.stageId)).map((x) => [x.entrantId, [x.played, x.points]]));
    expect(table, "the table is the one before the withdrawal").toEqual(preTable);
  }, 120_000);

  // Round 2 (C): a scorer's own Undo just before the withdrawal stays undone. The ledger keeps no writer, so a void the
  // scorer wrote cannot be told from the cascade's once written; the row lists exactly what the cascade removed.
  // differential: round 1 walked back through every void before the expunge and brought the undone game back.
  it("X-WDT-8 a scorer's Undo before the withdrawal stays undone after Reinstate", async () => {
    const r = await started(4);
    const [p1, p2] = [r.id.get("P1")!, r.id.get("P2")!];
    const line = await lineBetween(r.stageId, p1, p2);
    await post(r.auth, line.id, "core.start");
    const g = await post(r.auth, line.id, "badminton.game.summary", { home: 21, away: 10 });
    await scoreEvent(r.auth, line.id, { expected_seq: await tip(line.id), type: "core.void", payload: { event_id: g.event_id } } as never);
    const pre = await lineState(line.id);
    expect(pre.events.map((e) => e[0]), "rig: the game is undone, the Start stands").toEqual(["core.start"]);
    await withdrawEntrantCascade(r.auth, p1);
    expect(await hasActiveExpunge(line.id), "rig: expunged").toBe(true);
    await patchEntrant(r.auth, p1, { status: "registered" });
    expect(await lineState(line.id), "exactly as before the withdrawal: the undone game is not brought back").toEqual(pre);
  }, 120_000);

  // m1 (round 1) as re-ruled in rounds 2 and 3: a cascade with no rows (from before the rows existed — neither its
  // `table_withdrawal` row nor its write-ahead `table_withdrawal_line` rows) is still reversed from the score ledger's own
  // cascade events — but with no list of what it removed, nothing is re-recorded: the removed result's line is owed again
  // (its Start stands), the never-played lines are scheduled again.
  it("X-WDT-8 a withdrawal with no ledger row: the lines come back, a removed result is owed again", async () => {
    const r = await started(4);
    const [p1, p2] = [r.id.get("P1")!, r.id.get("P2")!];
    const signed = await lineBetween(r.stageId, p1, p2);
    await playBadminton(r.auth, signed.id, true);
    const pre = Object.fromEntries(await Promise.all((await linesOf(r.stageId)).filter((l) => involves(l, p1)).map(async (l) => [l.id, await lineState(l.id)] as const)));
    await withdrawEntrantCascade(r.auth, p1);
    await sql`delete from division_events where division_id = ${r.divisionId} and type in ('table_withdrawal', 'table_withdrawal_line')`;
    expect(await withdrawalRows(r.divisionId), "rig: a legacy withdrawal, no row").toEqual([]);
    await patchEntrant(r.auth, p1, { status: "registered" });
    let checked = 0;
    for (const id of Object.keys(pre)) {
      const now = await lineState(id);
      if (id === signed.id) {
        expect([now.outcome, now.events], "owed again: no result, its Start stands").toEqual([null, pre[id]!.events.filter((e) => e[0] === "core.start")]);
        expect(await hasActiveExpunge(id), "the expunge is taken back").toBe(false);
      } else expect(now, "a never-played line: back as it was").toEqual(pre[id]);
      checked++;
    }
    expect(checked).toBe(3);
  }, 120_000);

  // Round 2 (m1): the organiser's No result (`core.abandon{noResult}`) is writer-only (rebase ruling D3), so a re-record of
  // one through the cascade's writer is refused. Found: the cascade never removes one — the line is abandoned, neither
  // played nor pending, and is left as it is. Should a row ever list one, it goes back through its own writer and never
  // blocks the Reinstate (the second half forces that case: the row is made to list it).
  it("X-WDT-8 a No result line: the withdrawal leaves it, and a listed No result is re-recorded through its own writer", async () => {
    const r = await started(4);
    const [p1, p2] = [r.id.get("P1")!, r.id.get("P2")!];
    const line = await lineBetween(r.stageId, p1, p2);
    await post(r.auth, line.id, "core.start");
    await scoreEvent(r.auth, line.id, { expected_seq: await tip(line.id), type: "core.abandon", payload: { reason: "No result", noResult: true } } as never, { writer: "organiser_no_result" });
    const pre = await lineState(line.id);
    expect(pre.status, "rig: a No result").toBe("abandoned");
    await withdrawEntrantCascade(r.auth, p1);
    expect(await lineState(line.id), "the withdrawal does not remove a No result").toEqual(pre);
    // Forced: a write-ahead line row lists the No result as removed, and it is voided (as the cascade would have).
    const [nr] = await sql<{ id: string }[]>`select id from score_events where fixture_id = ${line.id} and type = 'core.abandon'`;
    const from = await tip(line.id);
    await sql`insert into division_events (division_id, seq, type, payload)
              select ${r.divisionId}, coalesce(max(seq), 0) + 1, 'table_withdrawal_line',
                     ${sql.json({ entrant_id: p1, stage_id: r.stageId, fixture_id: line.id, planned_void_ids: [nr!.id], from_seq: from } as never)}
                from division_events where division_id = ${r.divisionId}`;
    await scoreEvent(r.auth, line.id, { expected_seq: await tip(line.id), type: "core.void", payload: { event_id: nr!.id } } as never, { writer: "withdrawal_cascade" });
    await patchEntrant(r.auth, p1, { status: "registered" });
    expect(await lineState(line.id), "re-recorded through the No result's own writer: as it was").toEqual(pre);
  }, 120_000);

  // Round 2 (m3): a line rescored between the withdrawal and the Reinstate is left as the organiser left it, and NAMED.
  it("X-WDT-8 a line rescored after the withdrawal is left as it is and named in not_restored", async () => {
    const r = await started(4);
    const [p1, p2] = [r.id.get("P1")!, r.id.get("P2")!];
    const signed = await lineBetween(r.stageId, p1, p2);
    await playBadminton(r.auth, signed.id, true);
    await withdrawEntrantCascade(r.auth, p1);
    const [exp] = await sql<{ id: string }[]>`select id from score_events where fixture_id = ${signed.id} and type = 'core.abandon'`;
    await scoreEvent(r.auth, signed.id, { expected_seq: await tip(signed.id), type: "core.void", payload: { event_id: exp!.id } } as never);
    await post(r.auth, signed.id, "badminton.game.summary", { home: 5, away: 21 });
    const rescored = await lineState(signed.id);
    await writeEntrantPatch(r.auth, p1, { status: "registered" });
    const out = await reinstateTableEntrant(r.auth, p1);
    expect(out.not_restored, "the rescored line is named").toEqual([signed.id]);
    expect(await lineState(signed.id), "and left as the organiser left it").toEqual(rescored);
  }, 120_000);

  // Final fix wave (m3): the reply's `reinstate.not_restored` reaches the organiser. Through the REAL producer (the PATCH door,
  // `patchEntrant`, the reply as the route serializes it - JSON, then the wire schema) and the REAL reader the entrants panel
  // calls (`reinstateNotice`). Differential: before the fix nothing read the field, so the panel said nothing.
  it("m3 a Reinstate whose line was rescored: the PATCH reply names it and the panel's reader (`reinstateReplyNotice`) says so; an untouched one says nothing", async () => {
    const r = await started(4);
    const [p1, p2, p3] = [r.id.get("P1")!, r.id.get("P2")!, r.id.get("P3")!];
    const signed = await lineBetween(r.stageId, p1, p2);
    await playBadminton(r.auth, signed.id, true);
    await withdrawEntrantCascade(r.auth, p1);
    const [exp] = await sql<{ id: string }[]>`select id from score_events where fixture_id = ${signed.id} and type = 'core.abandon'`;
    await scoreEvent(r.auth, signed.id, { expected_seq: await tip(signed.id), type: "core.void", payload: { event_id: exp!.id } } as never);
    await post(r.auth, signed.id, "badminton.game.summary", { home: 5, away: 21 });
    const reply = PatchedEntrant.parse(JSON.parse(JSON.stringify(await patchEntrant(r.auth, p1, { status: "registered" }))));
    expect(reply.reinstate?.not_restored, "premise: the rescored line is the one not restored").toEqual([signed.id]);
    const said = reinstateReplyNotice(reply, p1, { [p1]: "P1" }, { locale: "en" });
    expect(said.map((l) => [l.tone, "plural" in l ? l.count : null]), "one line, todo, counting what the reply names").toEqual([["todo", 1]]);

    // The positive pair: a Reinstate that put everything back says nothing.
    await withdrawEntrantCascade(r.auth, p3);
    const clean = PatchedEntrant.parse(JSON.parse(JSON.stringify(await patchEntrant(r.auth, p3, { status: "registered" }))));
    expect(clean.reinstate?.not_restored, "premise: this reinstate ran and restored everything").toEqual([]);
    expect(reinstateReplyNotice(clean, p3, { [p3]: "P3" }, { locale: "en" })).toEqual([]);
  }, 120_000);

  // m3: an Add match line (`adhoc-N`) is one of her ordinary lines (the stated decision): counted, expunged, walked over, and
  // back on Reinstate.
  it("an Add match line is counted, expunged or walked over, and back on Reinstate", async () => {
    for (const policy of ["expunge", "walkover"] as const) {
      const r = await started(4);
      const [p1, p2, p3, p4] = ["P1", "P2", "P3", "P4"].map((k) => r.id.get(k)!) as [string, string, string, string];
      const { fixture_id: extra } = await addFixture(r.auth, r.stageId, { home_entrant_id: p1, away_entrant_id: p2 });
      expect((await lineOf(extra)).ext_key, "rig: an Add match line").toMatch(/^adhoc-/);
      // 4 lines: expunge with 1 played (under half); walkover with 2 played (half).
      await walkoverAgainst(r.auth, (await lineBetween(r.stageId, p1, p3)).id, p3);
      if (policy === "walkover") await walkoverAgainst(r.auth, (await lineBetween(r.stageId, p1, p4)).id, p4);
      const pre = await lineState(extra);
      const out = await withdrawEntrantCascade(r.auth, p1);
      expect(out.policy, policy).toBe(policy);
      const { loadTableWithdrawals } = await import("@/server/public-site/table-withdrawals");
      expect((await loadTableWithdrawals(r.divisionId)).map((x) => x.scheduled), `${policy}: the Add match line is one of her 4`).toEqual([4]);
      const gone = await lineOf(extra);
      if (policy === "expunge") expect([gone.status, await hasActiveExpunge(extra)], "expunged with the rest").toEqual(["abandoned", true]);
      else expect(gone.outcome, "walked over to the opponent").toMatchObject({ kind: "award", winner: p2, reason: "withdrew" });
      await patchEntrant(r.auth, p1, { status: "registered" });
      expect(await lineState(extra), `${policy}: back as it was`).toEqual(pre);
    }
  }, 240_000);

  it("X-WDT-8 Reinstate after walkovers: unplayed walkovers return to scheduled", async () => {
    const r = await started(4);
    const [p1, p2, p3, p4] = ["P1", "P2", "P3", "P4"].map((k) => r.id.get(k)!) as [string, string, string, string];
    await walkoverAgainst(r.auth, (await lineBetween(r.stageId, p1, p2)).id, p2);
    await walkoverAgainst(r.auth, (await lineBetween(r.stageId, p1, p3)).id, p3);
    await withdrawEntrantCascade(r.auth, p1);
    expect((await lineBetween(r.stageId, p1, p4)).outcome, "rig: walked over to P4").toMatchObject({ winner: p4, reason: "withdrew" });
    await patchEntrant(r.auth, p1, { status: "registered" });
    const owed = await lineBetween(r.stageId, p1, p4);
    expect([owed.status, owed.outcome], "the never-played walkover is scheduled again").toEqual(["scheduled", null]);
    for (const o of [p2, p3]) {
      expect((await lineBetween(r.stageId, p1, o)).outcome, "a played result is untouched").toMatchObject({ kind: "award", winner: p1, reason: "walkover" });
    }
  }, 120_000);

  it("X-WDT-8 after Reinstate the footnote is gone", async () => {
    const r = await started(4);
    const p1 = r.id.get("P1")!;
    await withdrawEntrantCascade(r.auth, p1);
    await patchEntrant(r.auth, p1, { status: "registered" });
    const rows = await withdrawalRows(r.divisionId);
    expect(rows.map((x) => x.type), "the row is voided by a second row, append-only").toEqual(["table_withdrawal", "table_withdrawal_voided"]);
    expect(rows[1]!.payload, "it names the row it voids").toEqual({ voids_seq: rows[0]!.seq });
    const { loadTableWithdrawals } = await import("@/server/public-site/table-withdrawals");
    expect(await loadTableWithdrawals(r.divisionId), "no active row: the footnote has nothing to say").toEqual([]);
  }, 120_000);

  it("a second withdrawal after a Reinstate writes a fresh row with the new count", async () => {
    const r = await started(4);
    const [p1, p2] = [r.id.get("P1")!, r.id.get("P2")!];
    await withdrawEntrantCascade(r.auth, p1);
    await patchEntrant(r.auth, p1, { status: "registered" });
    await walkoverAgainst(r.auth, (await lineBetween(r.stageId, p1, p2)).id, p2);
    await withdrawEntrantCascade(r.auth, p1);
    const { loadTableWithdrawals } = await import("@/server/public-site/table-withdrawals");
    const active = await loadTableWithdrawals(r.divisionId);
    expect(active.map((x) => [x.entrant_id, x.policy, x.played_at_departure, x.scheduled])).toEqual([[p1, "expunge", 1, 3]]);
  }, 120_000);

  it("two withdrawals sharing a line: the shared line stays out until both are back", async () => {
    const r = await started(4);
    const [p1, p2] = [r.id.get("P1")!, r.id.get("P2")!];
    const shared = await lineBetween(r.stageId, p1, p2);
    await withdrawEntrantCascade(r.auth, p1);
    await withdrawEntrantCascade(r.auth, p2);
    expect(await hasActiveExpunge(shared.id), "rig: the shared line is out").toBe(true);
    await patchEntrant(r.auth, p1, { status: "registered" });
    expect(await hasActiveExpunge(shared.id), "P2 is still gone: the shared line stays out").toBe(true);
    const p1Other = (await linesOf(r.stageId)).filter((l) => involves(l, p1) && l.id !== shared.id);
    for (const l of p1Other) expect(l.status, "P1's other lines are back").toBe("scheduled");
    await patchEntrant(r.auth, p2, { status: "registered" });
    expect([(await lineOf(shared.id)).status, await hasActiveExpunge(shared.id)], "both back: the shared line is owed").toEqual(["scheduled", false]);
    const { loadTableWithdrawals } = await import("@/server/public-site/table-withdrawals");
    expect(await loadTableWithdrawals(r.divisionId)).toEqual([]);
  }, 120_000);

  it("a Reinstate after the table finished reverses nothing (RB5-L8), and the footnote stops naming her", async () => {
    const r = await started(3);
    const [p1, p2, p3] = [r.id.get("P1")!, r.id.get("P2")!, r.id.get("P3")!];
    await withdrawEntrantCascade(r.auth, p1);
    await playBadminton(r.auth, (await lineBetween(r.stageId, p2, p3)).id, true);
    await completeStage(r.auth, r.stageId);
    const [st] = await sql<{ status: string }[]>`select status from stages where id = ${r.stageId}`;
    expect(st!.status, "rig: the table is complete").toBe("complete");
    await patchEntrant(r.auth, p1, { status: "registered" });
    for (const l of (await linesOf(r.stageId)).filter((x) => involves(x, p1))) {
      expect(await hasActiveExpunge(l.id), `line ${l.ext_key}: a finished table's lines are not reopened`).toBe(true);
    }
    const { loadTableWithdrawals } = await import("@/server/public-site/table-withdrawals");
    const { withdrawalNotesFor } = await import("@/lib/table-withdrawal-note");
    const records = await loadTableWithdrawals(r.divisionId);
    expect(records.map((x) => x.entrant_id), "the row stands with the table").toEqual([p1]);
    expect(withdrawalNotesFor(r.stageId, [p1, p2, p3], records, { [p1]: "registered" }, {}, null), "she is playing again: no note").toEqual([]);
  }, 120_000);

  it("a member a late entrant owes catch-up against: expunged, and back on Reinstate", async () => {
    const r = await started(4);
    const m = r.id.get("P2")!;
    const [late] = await createEntrants(r.auth, r.divisionId, [{ kind: "individual", display_name: "Late", seed: null, members: [] }] as never);
    const owed = await lineBetween(r.stageId, late!.id, m);
    await withdrawEntrantCascade(r.auth, m);
    expect(await hasActiveExpunge(owed.id), "the catch-up line against the leaver is expunged with her other lines").toBe(true);
    await patchEntrant(r.auth, m, { status: "registered" });
    expect([(await lineOf(owed.id)).status, await hasActiveExpunge(owed.id)], "the catch-up line is owed again").toEqual(["scheduled", false]);
  }, 120_000);

  it("a team table (football) and a pair (badminton doubles) take the same path", async () => {
    for (const opts of [{ sport: "football" }, { sport: "badminton", kind: "pair" as const }]) {
      const r = await started(4, opts);
      const p1 = r.id.get("P1")!;
      const out = await withdrawEntrantCascade(r.auth, p1);
      expect(out, `${opts.sport}/${opts.kind ?? "default"}: nothing played, expunge`).toMatchObject({ policy: "expunge", voided: 3 });
      await patchEntrant(r.auth, p1, { status: "registered" });
      const mine = (await linesOf(r.stageId)).filter((l) => involves(l, p1));
      expect(mine.map((l) => l.status), `${opts.sport}: every line back`).toEqual(["scheduled", "scheduled", "scheduled"]);
    }
  }, 240_000);
});

describe.skipIf(!HAS_DB)("Undo and the table-withdrawal rows", () => {
  it("history lists an expunge and its Reinstate once each; the per-line rows never show", async () => {
    // differential: before the filter, Recent edits and API v1 history listed every write-ahead line row and its retirement
    // by raw type name — 2 per line — around the two real entries.
    const r = await started(4);
    const p1 = r.id.get("P1")!;
    const hers = (await linesOf(r.stageId)).filter((l) => involves(l, p1));
    await withdrawEntrantCascade(r.auth, p1);
    await patchEntrant(r.auth, p1, { status: "registered" });
    const [stored] = await sql<{ lines: number; retired: number }[]>`
      select count(*) filter (where type = 'table_withdrawal_line')::int as lines,
             count(*) filter (where type = 'table_withdrawal_line_voided')::int as retired
        from division_events where division_id = ${r.divisionId}`;
    expect([stored!.lines, stored!.retired], "premise: a row and a retirement per line are stored").toEqual([hers.length, hers.length]);
    const listed = (await divisionHistory(r.auth, r.divisionId)).events.map((e) => e.type);
    expect(listed.filter((t) => t.startsWith("table_withdrawal_line")), "no internal row is listed").toEqual([]);
    // W5 T10b (ruling 292): the Reinstate's own trace is stored for every stage kind and never listed.
    const [traced] = await sql<{ n: number }[]>`select count(*)::int as n from division_events where division_id = ${r.divisionId} and type = 'withdrawal_reinstated'`;
    expect(traced!.n, "premise: the Reinstate wrote its trace").toBe(1);
    expect(listed.filter((t) => t === "withdrawal_reinstated"), "the trace is not a history entry").toEqual([]);
    expect(listed.filter((t) => t.startsWith("table_withdrawal")), "one entry for the withdrawal, one for the Reinstate (newest first)")
      .toEqual(["table_withdrawal_voided", "table_withdrawal"]);
  }, 120_000);

  it("the rows are not history steps and not barriers: Undo steps over them", () => {
    expect(isReversible("table_withdrawal"), "not a step Undo inverts").toBe(false);
    expect(isReversible("table_withdrawal_voided")).toBe(false);
    expect(isReversible("table_withdrawal_line"), "the write-ahead line row (re-review 2) neither").toBe(false);
    expect(isReversible("table_withdrawal_line_voided")).toBe(false);
    expect(isReversible("withdrawal_reinstated"), "T10b: the Reinstate trace neither").toBe(false);
    const ledger = [
      { seq: 1, type: "fixtures_generated", payload: {} },
      { seq: 2, type: "table_withdrawal_line", payload: {} },
      { seq: 3, type: "table_withdrawal", payload: {} },
      { seq: 4, type: "table_withdrawal_line_voided", payload: { voids_seq: 2 } },
      { seq: 5, type: "table_withdrawal_voided", payload: { voids_seq: 3 } },
      { seq: 6, type: "withdrawal_reinstated", payload: { entrant_id: "e" } },
    ];
    expect(undoBarrierRefusal(ledger, 0), "an Undo crossing them is not refused").toBeNull();
  });
});

// ── helpers for the rendered text ───────────────────────────────────────────────────────────────────────────────────────
function interpolate(dict: Record<string, string>, key: string, vars?: Record<string, string | number>): string {
  const raw = dict[key];
  if (raw === undefined) throw new Error(`no ${key} in the dictionary`);
  return raw.replace(/\{(\w+)\}/g, (_, k: string) => String(vars?.[k] ?? `{${k}}`));
}
function text(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}
void sides;
