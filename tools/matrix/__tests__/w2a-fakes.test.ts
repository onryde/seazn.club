// The fakes' W2a fidelity (spec §5.4.2 D3, rules X-BR-1, X-BR-2, X-ST-1): a bracket fixture that ends level is HELD
// (needs_decision) and seats nobody; an organiser settle closes it, and only then does its winner advance; a second
// settle is refused by name. Expected statuses and seats come from the rule rows, and the outcome from the engine's own
// fold — never from the fake's text. Folds through loop D's kernel: red until D merges into the lane.
import { describe, expect, it } from "vitest";
import { RefusedCall } from "../lib/driver/types.ts";
import { commandOf, newModelState, type ModelState } from "../lib/model/commands.ts";
import { drawsAllowed, resolveSportCfg, stageCfg, variantKeys } from "../lib/sport-cfg.ts";
import { generateStream } from "../lib/streams/index.ts";
import type { RequestedOutcome } from "../lib/streams/types.ts";
import { offlineBuilderDefault } from "../lib/variants.ts";
import { Recorder, setUpDivision } from "../lib/scenarios/common.ts";
import type { CaseSpec } from "../lib/scenarios/types.ts";
import { FakeKnockoutDriver, FakeLeagueDriver } from "./fake-driver.ts";
import { ModelFakeDriver } from "./model-fake-driver.ts";

const SPORT = "football"; // single-sport: a level result is reachable here, and the rule is the stage kind's, not the sport's
const variant = offlineBuilderDefault(SPORT);
const variantOf = offlineBuilderDefault;

/** Two semis feeding a final (sf1 -> home seat, sf2 -> away seat), the stage reading as `kind`, started. */
async function bracket(kind: string, sport = SPORT): Promise<{ m: ModelState; d: ModelFakeDriver; sf1: string; sf2: string; fin: string; e: string[] }> {
  const d = new ModelFakeDriver({});
  const base = await newModelState({ driver: d, row: "league", sport, variant: variantOf(sport), entrants: 4, tag: "t" });
  if (d.stage === null) throw new Error("test: no stage");
  d.stage.kind = kind;
  const m: ModelState = { ...base, stageKind: kind };
  const [e1, e2, e3, e4] = m.entrants as [string, string, string, string];
  const sf1 = d.seat(1, e1, e4);
  const sf2 = d.seat(1, e2, e3);
  const fin = d.seat(2, null, null);
  d.feed(sf1.id, fin.id, 1);
  d.feed(sf2.id, fin.id, 2);
  const start = commandOf("Start", 0, 0, false);
  expect(start.check(m)).toBe(true);
  await start.run(m, d);
  return { m, d, sf1: sf1.id, sf2: sf2.id, fin: fin.id, e: [e1, e2, e3, e4] };
}
const row = (d: ModelFakeDriver, id: string) => d.fixtures.find((f) => f.id === id)!;
function stream(d: ModelFakeDriver, id: string, kind: string, outcome: RequestedOutcome, sport = SPORT) {
  const f = row(d, id);
  return generateStream({ sportKey: sport, cfg: stageCfg(sport, resolveSportCfg(sport, variantOf(sport)), kind as never), stageKind: kind as never, home: f.home_entrant_id!, away: f.away_entrant_id!, outcome });
}

describe("the model fake serves the W2a status and seats (X-BR-1, X-BR-2, X-ST-1)", () => {
  it("a level result in a knockout is HELD as needs_decision and seats nobody; the same result in a league is decided (X-DR-1's allow-list is the stage kind)", async () => {
    const ko = await bracket("knockout");
    await ko.d.postStream(ko.sf1, stream(ko.d, ko.sf1, "knockout", { kind: "level" }));
    expect(row(ko.d, ko.sf1).status).toBe("needs_decision");
    expect((row(ko.d, ko.sf1).outcome as { kind: string }).kind).toMatch(/^(draw|tie|no_result)$/);
    expect(row(ko.d, ko.fin).home_entrant_id, "a held match seats nobody").toBeNull();
    const league = await bracket("league");
    await league.d.postStream(league.sf1, stream(league.d, league.sf1, "league", { kind: "draw" }));
    expect(row(league.d, league.sf1).status).toBe("decided");
  });

  it("a plain win in a knockout still decides and seats its winner (the positive pair of the hold)", async () => {
    const { d, sf1, fin, e } = await bracket("knockout");
    await d.postStream(sf1, stream(d, sf1, "knockout", { kind: "win", winner: "home" }));
    expect(row(d, sf1).status).toBe("decided");
    expect(row(d, fin).home_entrant_id).toBe(e[0]);
  });

  it("an organiser settle closes a held match: decided, a settled_<method> win by the chosen side, the winner seated; a SECOND settle is refused by name and writes nothing", async () => {
    const { d, sf1, fin, e } = await bracket("knockout");
    await d.postStream(sf1, stream(d, sf1, "knockout", { kind: "level" }));
    const settled = stream(d, sf1, "knockout", { kind: "settle", then: "away", method: "lot", after: "level" }).slice(-1);
    expect(settled.map((x) => x.type)).toEqual(["core.settle"]);
    await d.postStream(sf1, settled);
    expect(row(d, sf1).status).toBe("decided");
    expect(row(d, sf1).outcome).toMatchObject({ kind: "win", winner: e[3], method: "settled_lot" });
    expect(row(d, fin).home_entrant_id, "the settled winner advances").toBe(e[3]);
    const before = d.ledgers.get(sf1)!.length;
    const refusal = await d.postStream(sf1, settled).then(() => null, (x: unknown) => x);
    expect(refusal).toBeInstanceOf(RefusedCall);
    expect(refusal).toMatchObject({ status: 409, code: "SETTLE_NOT_APPLICABLE" });
    expect(d.ledgers.get(sf1)!.length, "a refused settle writes nothing").toBe(before);
  });

  it("an abandoned match seats nobody until it is settled (X-BR-2): abandon -> abandoned, settle -> decided and seated", async () => {
    const { d, sf2, fin, e } = await bracket("knockout");
    const events = stream(d, sf2, "knockout", { kind: "settle", then: "home", method: "organiser", after: "abandon" });
    const abandonAt = events.findIndex((x) => x.type === "core.abandon");
    expect(abandonAt, "the settle stream abandons first").toBeGreaterThan(0);
    await d.postStream(sf2, events.slice(0, abandonAt + 1));
    expect(row(d, sf2).status).toBe("abandoned");
    expect(row(d, fin).away_entrant_id, "an abandoned match seats nobody").toBeNull();
    await d.postStream(sf2, events.slice(abandonAt + 1));
    expect(row(d, sf2).status, "an active settle decides even an abandoned match").toBe("decided");
    expect(row(d, fin).away_entrant_id).toBe(e[1]);
  });

  it("a chess game drawn in a knockout is folded under the STAGE's cfg (BG-KO-1): held for its tie-break (not decided, not level, nobody seated), and the recorded rung decides and seats it", async () => {
    const { d, sf1, fin, e } = await bracket("knockout", "boardgame");
    const events = stream(d, sf1, "knockout", { kind: "tiebreak", rung: "blitz", winner: "away" }, "boardgame");
    expect(events.at(-1)!.type).toBe("boardgame.tiebreak");
    await d.postStream(sf1, events.slice(0, -1)); // start + the drawn game
    expect(row(d, sf1).outcome, "the drawn game awaits its tie-break").toBeNull();
    expect(row(d, sf1).status).toBe("in_play");
    expect(row(d, fin).home_entrant_id).toBeNull();
    await d.postStream(sf1, events.slice(-1));
    expect(row(d, sf1).status).toBe("decided");
    expect(row(d, sf1).outcome).toMatchObject({ kind: "win", winner: e[3], method: "tiebreak_blitz" });
    expect(row(d, fin).home_entrant_id).toBe(e[3]);
    // The same drawn game in a LEAGUE is just a draw: the overlay is the bracket's alone.
    const league = await bracket("league", "boardgame");
    await league.d.postStream(league.sf1, stream(league.d, league.sf1, "league", { kind: "draw" }, "boardgame"));
    expect(row(league.d, league.sf1)).toMatchObject({ status: "decided", outcome: { kind: "draw" } });
  });

  it("the scenario fakes (FakeKnockoutDriver) hold a level knockout result the same way: needs_decision, the next round unseated, then the settle seats", async () => {
    const driver = new FakeKnockoutDriver();
    const spec: CaseSpec = { caseId: "knockout|football|LIFECYCLE", row: "knockout", sport: SPORT, variant, scenario: "LIFECYCLE", canary: false };
    const ctx = { driver, spec, orgSlug: "o", cfg: resolveSportCfg(SPORT, variant), tag: "t", denied: [] };
    await setUpDivision(ctx, new Recorder(), 4);
    await driver.start();
    const first = driver.fixtures.find((f) => f.home_entrant_id !== null && f.away_entrant_id !== null && f.round_no === 1)!;
    const level = stream(driver as never, first.id, "knockout", { kind: "level" });
    await driver.postStream(first.id, level);
    expect(first.status).toBe("needs_decision");
    expect(driver.fixtures.filter((f) => f.round_no === 2).flatMap((f) => [f.home_entrant_id, f.away_entrant_id]).filter((x) => x === first.home_entrant_id || x === first.away_entrant_id), "a held match seats nobody").toEqual([]);
    await driver.postStream(first.id, [{ type: "core.settle", payload: { winner: first.home_entrant_id!, method: "higher_seed" } }]);
    expect(first.status).toBe("decided");
    expect(driver.fixtures.filter((f) => f.round_no === 2).some((f) => f.home_entrant_id === first.home_entrant_id || f.away_entrant_id === first.home_entrant_id), "the settled winner advances").toBe(true);
  });

  it("GN-KO-1: a generic draw in a knockout is REFUSED (409 LEVEL_RESULT_IN_BRACKET) and the result is not written; the same draw in a league is decided, and a football level result in the same knockout is accepted and held", async () => {
    let checked = 0;
    for (const v of variantKeys("generic")) {
      const cfg = resolveSportCfg("generic", v);
      if (!drawsAllowed("generic", cfg, "league")) continue; // no draw stream exists to refuse
      const driver = new FakeKnockoutDriver();
      const spec: CaseSpec = { caseId: `knockout|generic|${v}|LIFECYCLE`, row: "knockout", sport: "generic", variant: v, scenario: "LIFECYCLE", canary: false };
      await setUpDivision({ driver, spec, orgSlug: "o", cfg, tag: "t", denied: [] }, new Recorder(), 4);
      await driver.start();
      const first = driver.fixtures.find((f) => f.home_entrant_id !== null && f.away_entrant_id !== null && f.round_no === 1)!;
      const draw = generateStream({ sportKey: "generic", cfg, stageKind: "league", home: first.home_entrant_id!, away: first.away_entrant_id!, outcome: { kind: "draw" } });
      const refused = await driver.postStream(first.id, draw).then(() => null, (e: unknown) => e);
      expect(refused, v).toBeInstanceOf(RefusedCall);
      expect(refused, v).toMatchObject({ status: 409, code: "LEVEL_RESULT_IN_BRACKET" });
      expect(first.status, `${v}: START was accepted, the draw was not`).toBe("in_play");
      expect(first.outcome, v).toBeNull();
      expect(driver.fixtures.filter((f) => f.round_no === 2).flatMap((f) => [f.home_entrant_id, f.away_entrant_id]).filter((x) => x !== null), `${v}: nobody advanced`).toEqual([]);
      checked++;
    }
    expect(checked, "no generic variant draws in a league: nothing was refused").toBeGreaterThan(0);
    // the positive pairs: the same draw is fine in a league (the bracket is the whole difference), and another sport's level result is held
    const leagueGeneric = await bracket("league", "generic");
    await leagueGeneric.d.postStream(leagueGeneric.sf1, stream(leagueGeneric.d, leagueGeneric.sf1, "league", { kind: "draw" }, "generic"));
    expect(row(leagueGeneric.d, leagueGeneric.sf1)).toMatchObject({ status: "decided", outcome: { kind: "draw" } });
  });

  it("GN-KO-1 is the bracket's alone, on the fake the scenarios drive: the same generic draw in a LEAGUE stage is accepted and decided", async () => {
    let checked = 0;
    for (const v of variantKeys("generic")) {
      const cfg = resolveSportCfg("generic", v);
      if (!drawsAllowed("generic", cfg, "league")) continue; // no draw stream exists
      const driver = new FakeLeagueDriver();
      const spec: CaseSpec = { caseId: `league|generic|${v}|LIFECYCLE`, row: "league", sport: "generic", variant: v, scenario: "LIFECYCLE", canary: false };
      await setUpDivision({ driver, spec, orgSlug: "o", cfg, tag: "t", denied: [] }, new Recorder(), 4);
      await driver.start();
      const first = driver.fixtures.find((f) => f.home_entrant_id !== null && f.away_entrant_id !== null)!;
      await driver.postStream(first.id, generateStream({ sportKey: "generic", cfg, stageKind: "league", home: first.home_entrant_id!, away: first.away_entrant_id!, outcome: { kind: "draw" } }));
      expect(first, v).toMatchObject({ status: "decided", outcome: { kind: "draw" } });
      checked++;
    }
    expect(checked, "no generic variant draws in a league").toBeGreaterThan(0);
  });
});
