// W2d Task 10 (spec §5.4 "Two moments, two effects", §13 rule 10; D9; PS-5d; rule row X-TB-2) — pin MONOTONICITY, as a
// sequence property. fast-check draws sequences over {stage own edit, division edit, sport-default stub change, activate,
// first score, void, regenerate} on one generic league, and after every step holds the stage's rules to a model:
//
//   - before activation the stage reads the live layers (own ?? division ?? sport);
//   - after activation NOTHING moves the pin but the stage's OWN valid save before the first score, and that save moves
//     only the field it saved (its cross-group order follows its order: derived, §5.9) — the division's order, the sport's
//     default (a module stub, `tableRulesOf`), a regenerate and a void move nothing, and the ranked rows do not move under a
//     division edit or a stub;
//   - after the first score every own save is 409 STAGE_FORMAT_LOCKED, and a void does not unlock it.
//
// Expected values come from the model (the values each step wrote) and the engine's declarations (`defaultTiebreakers`,
// `tablePointsRule`, `defaultCrossGroup`), never from the loader under test. Reports how many steps it checked. Real
// Postgres; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { PointsRule, defaultCrossGroup } from "@seazn/engine/competition";
import type { AnySportModule, TiebreakerKey } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import { appendEvent } from "@/server/engine-db";
import { recomputeStandings } from "@/server/engine-db/competition";
import { loadTableRules, tableRulesOf } from "@/server/engine-db/table-rules";
import { genericResult, seatedFixtures, tableRulesRowOf, tableScene } from "@/server/engine-db/__tests__/helpers/w2d-table-rig";
import { patchDivision } from "../divisions";
import { putStageRules } from "../stage-rules";
import { startDivision } from "../schedule";
import { generateStageFixtures } from "../stages";
import { GENERIC_CONFIG } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const generic = builtinModules.find((m) => m.key === "generic") as AnySportModule;
const CFG = generic.configSchema.parse(GENERIC_CONFIG);
const SPORT_ORDER = generic.defaultTiebreakers("league", CFG);
const SPORT_RULE = PointsRule.parse(generic.tablePointsRule(CFG, "league"));
const ORDERS: readonly TiebreakerKey[][] = [["points", "for", "diff", "lots"], ["points", "diff", "lots"]];
const RULES: readonly PointsRule[] = [
  PointsRule.parse({ win: { regulation: 2 }, loss: { regulation: 0 }, draw: 1, shootoutAs: "result", unit: "whole" }),
  PointsRule.parse({ win: { regulation: 5 }, loss: { regulation: 1 }, draw: 2, shootoutAs: "result", unit: "whole" }),
];
// The sport's default, as a release could change it (the stub answers otherwise on both layers).
const STUB_RULE = PointsRule.parse({ win: { regulation: 9 }, loss: { regulation: 0 }, draw: 4, shootoutAs: "result", unit: "whole" });
const STUB = { ...generic, defaultTiebreakers: () => [...ORDERS[1]!], tablePointsRule: () => STUB_RULE } as unknown as AnySportModule;

type Op =
  | { t: "own"; field: "tiebreakers" | "points"; v: number | null }
  | { t: "division"; v: number | null }
  | { t: "stub" }
  | { t: "activate" }
  | { t: "score" }
  | { t: "void" }
  | { t: "regenerate" };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ t: fc.constant("own" as const), field: fc.constantFrom("tiebreakers" as const, "points" as const), v: fc.option(fc.nat(1), { nil: null }) }),
  fc.record({ t: fc.constant("division" as const), v: fc.option(fc.nat(1), { nil: null }) }),
  fc.constant({ t: "stub" as const }),
  fc.constant({ t: "activate" as const }),
  fc.constant({ t: "score" as const }),
  fc.constant({ t: "void" as const }),
  fc.constant({ t: "regenerate" as const }),
);

interface Expected {
  points: PointsRule;
  tiebreakers: readonly TiebreakerKey[];
  crossGroup: readonly TiebreakerKey[];
  sources: { points: string; tiebreakers: string; crossGroup: string };
}

describe.skipIf(!HAS_DB)("W2d T10 rule 10: pin monotonicity over every sequence of table-rule writes", () => {
  it("after activation only the stage's own valid save before the first score moves its pin, and only the field it saved (counted)", async () => {
    let checked = 0;
    let lockedRefusals = 0;
    let pinnedMoves = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 2, maxLength: 7 }), async (ops) => {
        const s = await tableScene({});
        const stageId = s.stageIds[0]!;
        // The model: what the layers hold, and what the stage is pinned to once active.
        let ownOrder: readonly TiebreakerKey[] | null = null;
        let ownPoints: PointsRule | null = null;
        let divOrder: readonly TiebreakerKey[] | null = null;
        let pin: Expected | null = null;
        let pinnedAt: string | null = null;
        let scored = false;
        const played: { fixtureId: string; resultEventId: string }[] = [];
        const used = new Set<string>(); // a fixture is scored at most once (a voided one stays started)
        const live = (): Expected => {
          const order = ownOrder ?? divOrder ?? SPORT_ORDER;
          return {
            points: ownPoints ?? SPORT_RULE,
            tiebreakers: order,
            crossGroup: defaultCrossGroup(order),
            sources: { points: ownPoints ? "stage" : "sport", tiebreakers: ownOrder ? "stage" : divOrder ? "division" : "sport", crossGroup: "derived" },
          };
        };
        const holds = async (what: string) => {
          const got = await loadTableRules(sql, stageId);
          const want = pin ?? live();
          expect({ points: got.points, tiebreakers: got.tiebreakers, crossGroup: got.crossGroup, sources: got.sources }, what).toEqual(want);
          if (pin !== null) expect(got.pinnedAt, `${what}: the pin's date`).toBe(pinnedAt);
          checked++;
        };
        for (const op of ops) {
          const what = JSON.stringify(op);
          switch (op.t) {
            case "own": {
              const value = op.v === null ? null : op.field === "tiebreakers" ? ORDERS[op.v]! : RULES[op.v]!;
              const save = putStageRules(s.auth, stageId, { [op.field]: value });
              if (scored) {
                await expect(save, what).rejects.toMatchObject({ code: "STAGE_FORMAT_LOCKED" });
                lockedRefusals++;
                break;
              }
              await save;
              if (op.field === "tiebreakers") ownOrder = value as TiebreakerKey[] | null;
              else ownPoints = value as PointsRule | null;
              if (pin !== null) {
                // PS-5d: only the saved field re-pins, to the value saved or (cleared) the layer below as it stands now.
                const now = live();
                const was: Expected = pin;
                pin =
                  op.field === "tiebreakers"
                    ? { ...was, tiebreakers: now.tiebreakers, crossGroup: now.crossGroup, sources: { ...was.sources, tiebreakers: now.sources.tiebreakers, crossGroup: "derived" } }
                    : { ...was, points: now.points, sources: { ...was.sources, points: now.sources.points } };
                pinnedMoves++;
              }
              break;
            }
            case "division": {
              const value = op.v === null ? null : ORDERS[op.v]!;
              const rowsBefore = pin === null ? null : await recomputeStandings(s.auth.orgId, stageId);
              const out = await patchDivision(s.auth, s.divisionId, { tiebreakers: value });
              expect(out.refused, what).toEqual([]);
              divOrder = value;
              if (rowsBefore !== null) expect(await recomputeStandings(s.auth.orgId, stageId), `${what}: the ranked rows`).toEqual(rowsBefore);
              break;
            }
            case "stub": {
              const underStub = tableRulesOf(await tableRulesRowOf(stageId), STUB);
              if (pin !== null) {
                expect({ points: underStub.points, tiebreakers: underStub.tiebreakers }, `${what}: a release reaches no pinned stage`).toEqual({
                  points: pin.points, tiebreakers: pin.tiebreakers,
                });
              } else {
                // The counterfactual: a pending stage takes the release wherever no layer above the sport answers.
                if (ownPoints === null) expect(underStub.points, `${what}: pending, the release reaches it`).toEqual(STUB_RULE);
              }
              break;
            }
            case "activate": {
              if (pin !== null) break;
              const before = live();
              await generateStageFixtures(s.auth, stageId);
              await startDivision(s.auth, s.divisionId); // scoring opens (doc 12 §1); the pin is the generate's
              pin = before;
              pinnedAt = (await loadTableRules(sql, stageId)).pinnedAt;
              expect(pinnedAt, `${what}: pinned`).not.toBeNull();
              break;
            }
            case "regenerate": {
              if (pin === null) break;
              await generateStageFixtures(s.auth, stageId).catch(() => undefined); // refused or not, the pin is the question
              break;
            }
            case "score": {
              if (pin === null) break;
              const next = (await seatedFixtures(stageId)).find((f) => f.status === "scheduled" && !used.has(f.id));
              if (next === undefined) break;
              used.add(next.id);
              await genericResult(s.auth, stageId, next.home, next.away, 3, 1);
              const [ev] = await sql<{ id: string }[]>`
                select id from score_events where fixture_id = ${next.id} and type = 'generic.result' order by seq desc limit 1`;
              played.push({ fixtureId: next.id, resultEventId: ev!.id });
              scored = true;
              break;
            }
            case "void": {
              const last = played.pop();
              if (last === undefined) break;
              const [{ tip }] = await sql<{ tip: number }[]>`select coalesce(max(seq), -1)::int as tip from score_events where fixture_id = ${last.fixtureId}`;
              await appendEvent(s.auth.orgId, last.fixtureId, tip + 1, { type: "core.void", payload: {}, voids: last.resultEventId });
              break; // `scored` stays true: the lock is monotonic
            }
          }
          await holds(what);
        }
      }),
      { numRuns: 12, endOnFailure: true },
    );
    expect(checked, "anti-vacuity: steps checked").toBeGreaterThan(0);
    console.info(`[table-rules-sequence] checked ${checked} steps; ${pinnedMoves} own re-pins; ${lockedRefusals} locked refusals`);
  }, 600_000);
});
