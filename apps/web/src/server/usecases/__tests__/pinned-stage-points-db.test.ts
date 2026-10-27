// W2d final review I1 (controller ruling, 2026-10-26) — the data the organiser console's stage points card reads for a
// PINNED stage, through the real path: generate pins the stage, a division points save then lands (`rule-locks.ts` lets it
// through) and never reaches the stage, and `listPinnedStagePoints` (the page's loader for the card) still carries the
// PIN's points, never the division's new ones. Before this, the card read the live `division.config` and said a number the
// table did not pay.
//
// Expected values: the pin is the engine's own table rule for the division AS IT WAS when generate ran
// (`tablePointsRule`, a declaration — never the loader's answer), and the moved numbers are the ones the test saves, each
// chosen to differ from the pin so a loader reading the live division is visible. The state transitions (generate, a
// division save, a SECOND division save, an own stage save, its clear, the first score) and the empty case (a pending stage,
// no ids, another org) each have a case.
//
// Two sports, not the registry: the two spellings of a division's flat points (`win/draw/loss`, football; `w/d/l`, generic)
// — the loader is sport-blind (`stageTableRulesDocs`), so a sport adds no branch here. Real Postgres; skipped without
// DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { PointsRule } from "@seazn/engine/competition";
import type { AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { genericResult } from "@/server/engine-db/__tests__/helpers/w2d-table-rig";
import { loadTableRules } from "@/server/engine-db/table-rules";
import { createCompetition } from "../competitions";
import { createDivision, getDivision, patchDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { listPinnedStagePoints } from "../stage-qualification";
import { putStageRules } from "../stage-rules";
import { startDivision } from "../schedule";
import { createStages, generateStageFixtures } from "../stages";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const sport = (key: string): AnySportModule => builtinModules.find((m) => m.key === key)! as AnySportModule;

interface Case {
  sport: string;
  variant: string;
  /** The division's win key in its own points spelling. */
  winKey: "win" | "w";
}
const CASES: readonly Case[] = [
  { sport: "football", variant: "11-a-side", winKey: "win" },
  { sport: "generic", variant: "score", winKey: "w" },
];

/** A division of the sport (its declared cfg, stored with the schema's defaults), two entrants and two league stages:
 *  Pool A generated (pinned), Pool B left pending. */
async function rig(c: Case) {
  const { auth } = await seedOrg("pro");
  const suffix = randomUUID().slice(0, 8);
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "I1 " + suffix, visibility: "private", branding: {} });
  const m = sport(c.sport);
  const kind = m.entrantModel?.defaultKind ?? "individual";
  const d = await createDivision(auth, comp.id, { name: "Open", slug: "i1-" + suffix, sport_key: c.sport, variant_key: c.variant, config: {} });
  const entrants = await createEntrants(auth, d.id, [1, 2].map((i) => ({ kind, display_name: `E${i}`, seed: i, members: [] })));
  const [a] = await createStages(auth, d.id, { seq: 1, kind: "league", name: "Pool A", config: {}, progression: null });
  const [b] = await createStages(auth, d.id, { seq: 2, kind: "league", name: "Pool B", config: {}, progression: null });
  const asStored = (await getDivision(auth, d.id)).config as Record<string, unknown>;
  // The declaration the pin must equal: the sport's table rule for the division as generate saw it.
  const pin = PointsRule.parse(m.tablePointsRule(m.configSchema.parse(asStored), "league"));
  await generateStageFixtures(auth, a!.id);
  return { auth, m, divisionId: d.id, a: a!.id, b: b!.id, pin, entrants: [...entrants].sort((x, y) => (x.seed ?? 0) - (y.seed ?? 0)).map((e) => e.id) };
}

/** A division points save of `win` (the rest of the stored config untouched), through the product's own writer. */
async function saveDivisionWin(auth: AuthCtx, divisionId: string, winKey: string, win: number) {
  const cfg = (await getDivision(auth, divisionId)).config as Record<string, unknown> & { points: Record<string, number> };
  return patchDivision(auth, divisionId, { config: { ...cfg, points: { ...cfg.points, [winKey]: win } } });
}

describe.skipIf(!HAS_DB)("W2d final review I1: the console card's loader carries a pinned stage's PIN points after a division points save", () => {
  for (const c of CASES) {
    it(`${c.sport}: generate pins Pool A; a division points save (then a second) lands, and the card's data still carries the pin's win — Pool B (pending) is absent and follows the division`, async () => {
      const r = await rig(c);
      const pinnedWin = r.pin.win.regulation;
      expect((await loadTableRules(sql, r.a)).pinnedAt, "premise: generate pinned Pool A").not.toBeNull();
      expect((await loadTableRules(sql, r.b)).pinnedAt, "premise: Pool B is pending").toBeNull();

      // Right after generate: the pin is the division as it stood.
      const first = await listPinnedStagePoints(r.auth, [r.a, r.b]);
      expect(Object.keys(first), "only the pinned stage is carried").toEqual([r.a]);
      expect(first[r.a]).toEqual(r.pin);

      // A division points save: it lands ("Saved"), and names the pinned stage it did not reach.
      const moved = pinnedWin + 2;
      const out = await saveDivisionWin(r.auth, r.divisionId, c.winKey, moved);
      expect(out.refused, "the save is not refused").toEqual([]);
      expect((out.config as { points: Record<string, number> }).points[c.winKey], "written").toBe(moved);
      expect(out.stagesKeptPinned).toEqual([{ stageId: r.a, name: "Pool A" }]);

      const after = await listPinnedStagePoints(r.auth, [r.a, r.b]);
      expect(after[r.a], "the card's data: the PIN, not the division's new points").toEqual(r.pin);
      expect(after[r.a]!.win.regulation, "right (pin) and wrong (live) differ").not.toBe(moved);
      expect(after[r.a]!.win.regulation).toBe(pinnedWin);
      // The positive pair: the pending pool reads the live division, and the loader leaves it out (the card reads it live).
      expect(Object.keys(after)).toEqual([r.a]);
      expect((await loadTableRules(sql, r.b)).points.win.regulation, "Pool B follows the division").toBe(moved);

      // The sequence: a SECOND division save moves nothing either.
      await saveDivisionWin(r.auth, r.divisionId, c.winKey, pinnedWin + 4);
      expect((await listPinnedStagePoints(r.auth, [r.a, r.b]))[r.a], "a second save").toEqual(r.pin);
      expect((await loadTableRules(sql, r.a)).points, "and the table pays what the card says").toEqual(r.pin);
    });
  }

  it("generic sequence: an own save re-pins (the card carries it), its clear re-pins to the division AS IT STANDS (the live points, not the first pin), and the first score changes nothing", async () => {
    const c = CASES[1]!;
    const r = await rig(c);
    const moved = r.pin.win.regulation + 2;
    await saveDivisionWin(r.auth, r.divisionId, c.winKey, moved);
    expect((await listPinnedStagePoints(r.auth, [r.a]))[r.a], "premise: the pin held").toEqual(r.pin);

    // PS-5d: an own save before the first score re-pins the points.
    const own = PointsRule.parse({ win: { regulation: 7 }, loss: { regulation: 1 }, draw: 4, shootoutAs: "result", unit: "whole", bonuses: [] });
    await putStageRules(r.auth, r.a, { points: own });
    expect((await listPinnedStagePoints(r.auth, [r.a]))[r.a], "the own save is the pin now").toEqual(own);

    // Its clear re-pins the layer below as it stands NOW: the division's moved points (what the card must then say).
    await putStageRules(r.auth, r.a, { points: null });
    const liveCfg = (await getDivision(r.auth, r.divisionId)).config;
    const livePin = PointsRule.parse(r.m.tablePointsRule(r.m.configSchema.parse(liveCfg), "league"));
    expect(livePin.win.regulation, "premise: the live rule pays the moved win").toBe(moved);
    expect((await listPinnedStagePoints(r.auth, [r.a]))[r.a], "cleared: the live division, re-pinned").toEqual(livePin);

    // The first score: a started stage keeps the same pin, and a later division save still does not reach it.
    await startDivision(r.auth, r.divisionId);
    await genericResult(r.auth, r.a, r.entrants[0]!, r.entrants[1]!, 3, 1);
    await saveDivisionWin(r.auth, r.divisionId, c.winKey, moved + 3);
    expect((await listPinnedStagePoints(r.auth, [r.a]))[r.a], "after the first score and another division save").toEqual(livePin);
  });

  it("the empty cases: no ids reads nothing; another org's caller gets none of this org's pins", async () => {
    const r = await rig(CASES[0]!);
    expect(await listPinnedStagePoints(r.auth, []), "no ids").toEqual({});
    const { auth: other } = await seedOrg("pro");
    expect(await listPinnedStagePoints(other, [r.a, r.b]), "tenant scope").toEqual({});
    expect(Object.keys(await listPinnedStagePoints(r.auth, [r.a, r.b])), "and the owner's own read is not empty").toEqual([r.a]);
  });
});
