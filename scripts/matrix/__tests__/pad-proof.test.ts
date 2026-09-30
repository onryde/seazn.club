// PADPROOF (W1c Task 7), over the league fake with the pad path's answers
// (fake-pad-driver.ts). Swept over every sport with a pad: the expected
// outcomes come from the engine's own drawsAllowed, never from pad-proof.ts,
// and the set's cases come from the pad registry and the DB's variant order.
import { describe, expect, it } from "vitest";
import { SPORT_KEYS } from "../lib/catalogue.ts";
import { evaluateInvariants } from "../lib/invariants.ts";
import { winnerOf } from "../lib/observed.ts";
import { PAD_SPORTS, noPadReason } from "../lib/pad-sports.ts";
import { PAD_PROOF_SET, padProofPlanner } from "../lib/pad-proof-set.ts";
import { SetTakesNoFilter } from "../lib/probe-set.ts";
import { decideState } from "../lib/results.ts";
import { CANARY_MARK } from "../lib/scenarios/assertions.ts";
import { SCENARIOS } from "../lib/scenarios/index.ts";
import { NoPadAdapter } from "../lib/scenarios/pad-proof.ts";
import { ScenarioUnsupported, type CaseSpec, type ScenarioContext } from "../lib/scenarios/types.ts";
import { SCENARIO_KEYS } from "../lib/slice.ts";
import { drawsAllowed, entrantKindFor, resolveSportCfg } from "../lib/sport-cfg.ts";
import type { StreamEvent } from "../lib/streams/types.ts";
import { offlineBuilderDefault } from "../lib/variants.ts";
import { FakeLeagueDriver } from "./fake-driver.ts";
import { FakePadDriver } from "./fake-pad-driver.ts";

const padProof = SCENARIOS.PADPROOF;

function ctxOf(driver: FakeLeagueDriver, sport: string, canary = false): ScenarioContext {
  const variant = offlineBuilderDefault(sport);
  const spec: CaseSpec = { caseId: `league|${sport}|${variant}|PADPROOF`, row: "league", sport, variant, scenario: "PADPROOF", canary };
  return { driver, spec, orgSlug: "o", cfg: resolveSportCfg(sport, variant), tag: "t", denied: [] };
}
async function run(driver: FakeLeagueDriver, sport: string, canary = false) {
  const out = await padProof.run(ctxOf(driver, sport, canary));
  const checks = [...evaluateInvariants(out.observed), ...out.assertions];
  return { out, checks, byId: (id: string) => checks.find((c) => c.id === id)!, state: decideState({ checks, deferred: null, error: null }).state };
}

/** A pad that writes the other side's win: the sides of every scored payload swapped. */
function otherWinner(evs: readonly StreamEvent[]): StreamEvent[] {
  return evs.map((e) => {
    const p = e.payload as Record<string, unknown>;
    if (e.type === "generic.result" && typeof p.p1Score === "number") return { type: e.type, payload: { p1Score: p.p2Score, p2Score: p.p1Score } };
    if (e.type.endsWith(".summary") && typeof p.home === "number") return { type: e.type, payload: { home: p.away, away: p.home } };
    return e;
  });
}

/** An http-shaped driver that finalizes but answers no `stored` — what HttpDriver is to this scenario. */
class FinalizingHttp extends FakePadDriver {
  override async postStream(id: string, events: readonly StreamEvent[], prefix = "") {
    return (await super.postStream(id, events, prefix)).map(({ stored: _s, ...http }) => http);
  }
}

describe("PADPROOF", () => {
  it("empty case first: a league whose start seats no fixture fails pad-finalized with checked 0, and decides nothing", async () => {
    class Empty extends FakePadDriver {
      override start() { this.stage!.status = "active"; return Promise.resolve({ division_id: "d1", status: "active", started: true, generated: 0 }); }
    }
    const d = new Empty();
    const r = await run(d, "generic");
    expect(d.fixtures).toHaveLength(0);
    expect(r.byId("pad-finalized")).toMatchObject({ verdict: "fail", checked: 0 });
    expect(r.byId("pad-stream-stored")).toMatchObject({ verdict: "fail", checked: 0 });
    expect(r.byId("pad-outcome-as-requested")).toMatchObject({ verdict: "fail", checked: 0 });
    expect(d.finalized).toEqual([]);
  });

  it.each(PAD_SPORTS.map((s) => [s]))("%s: 3 entrants → 3 fixtures decided on the pad as [home, draw-or-away, away], each finalized; every check passes", async (sport) => {
    const d = new FakePadDriver();
    const r = await run(d, sport);
    const drawOk = drawsAllowed(sport, resolveSportCfg(sport, offlineBuilderDefault(sport)), "league");
    const fx = [...d.fixtures].sort((a, b) => (a.fixture_no ?? 0) - (b.fixture_no ?? 0));
    expect(fx).toHaveLength(3);
    const want = [fx[0]!.home_entrant_id, drawOk ? null : fx[1]!.away_entrant_id, fx[2]!.away_entrant_id];
    expect(fx.map((f) => (f.outcome as { kind: string }).kind)).toEqual(["win", drawOk ? "draw" : "win", "win"]);
    expect(fx.map((f) => winnerOf(f.outcome as never))).toEqual(want);
    expect(fx.map((f) => f.status)).toEqual(["finalized", "finalized", "finalized"]);
    expect(d.finalized).toEqual(fx.map((f) => f.id));
    expect(r.byId("pad-finalized")).toMatchObject({ verdict: "pass", checked: 3 });
    expect(r.byId("pad-stream-stored")).toMatchObject({ verdict: "pass", checked: 3 });
    expect(r.byId("pad-outcome-as-requested")).toMatchObject({ verdict: "pass", checked: 3 });
    expect(r.checks.filter((c) => c.verdict === "fail").map((c) => c.id)).toEqual([]);
    expect(r.state).toBe("works");
    // Every fixture was posted once, on the pad (stored), and none twice.
    expect(d.calls.filter((c) => c === "postStream")).toHaveLength(3);
  });

  it("pad-outcome-as-requested: a pad that stores the other side's win fails it, per fixture, from the stored fold", async () => {
    // single-sport: the check reads only each fixture's request parity (pad-proof.ts:107), which no sport branches; the live pad-proof runs sweep all 11.
    const d = new FakePadDriver();
    d.storedAs = otherWinner;
    const r = await run(d, "badminton");
    const c = r.byId("pad-outcome-as-requested");
    expect(c).toMatchObject({ verdict: "fail", checked: 3 });
    expect(c.evidence).toHaveLength(3);
    for (const line of c.evidence) expect(line).toMatch(/: request mismatch$/);
  });

  it("the canary adds the deliberately wrong expectation: an honest pad fails the check only on the marked lines", async () => {
    // single-sport: withCanary (assertions.ts:22) marks lines without reading the sport, so one sport proves the marking.
    const r = await run(new FakePadDriver(), "generic", true);
    const c = r.byId("pad-outcome-as-requested");
    expect(padProof.canaryCheck).toBe("pad-outcome-as-requested");
    expect(c).toMatchObject({ verdict: "fail", checked: 6 });
    expect(c.evidence).toHaveLength(3);
    for (const line of c.evidence) expect(line.startsWith(CANARY_MARK)).toBe(true);
    expect(r.checks.filter((x) => x.verdict === "fail").map((x) => x.id)).toEqual(["pad-outcome-as-requested"]);
  });

  it("a driver without finalize fails pad-finalized naming it — and, answering no stored rows, pad-stream-stored too", async () => {
    const r = await run(new FakeLeagueDriver(), "generic");
    expect(r.byId("pad-finalized")).toMatchObject({ verdict: "fail", checked: 1 });
    expect(r.byId("pad-finalized").reason).toMatch(/no finalize/);
    expect(r.byId("pad-stream-stored")).toMatchObject({ verdict: "fail", checked: 3 });
  });

  it("a driver that finalizes but answers no stored rows (HttpDriver's shape) cannot claim the proof: pad-stream-stored fails every fixture", async () => {
    const d = new FinalizingHttp();
    const r = await run(d, "generic");
    expect(r.byId("pad-finalized")).toMatchObject({ verdict: "pass", checked: 3 });
    const s = r.byId("pad-stream-stored");
    expect(s).toMatchObject({ verdict: "fail", checked: 3 });
    for (const line of s.evidence) expect(line).toMatch(/not from rows the pad wrote$/);
  });

  it("a fixture the pad left undecided is tried ONCE, not finalized, and named by pad-finalized and life-loop-bounded", async () => {
    const d = new FakePadDriver();
    let n = 0;
    // The second fixture's pad stored only core.start: the fixture stays in play.
    d.storedAs = (evs) => (++n === 2 ? evs.slice(0, 1) : [...evs]);
    const r = await run(d, "generic");
    const fx = [...d.fixtures].sort((a, b) => (a.fixture_no ?? 0) - (b.fixture_no ?? 0));
    expect(fx.map((f) => f.status)).toEqual(["finalized", "in_play", "finalized"]);
    expect(d.calls.filter((c) => c === "postStream")).toHaveLength(3);
    expect(r.byId("pad-finalized")).toMatchObject({ verdict: "fail", checked: 3, evidence: [`${fx[1]!.id}: in_play, not decided — the console offers no Finalize`] });
    expect(r.byId("life-loop-bounded").verdict).toBe("fail");
  });

  it("a team-kind pad sport plays on rosterless team entrants (Tasks 9–11 Step 0: the pad scored volleyball beach with no roster), while every other scenario still defers team rosters to W1-driving", async () => {
    const team = PAD_SPORTS.filter((s) => entrantKindFor(s, resolveSportCfg(s, offlineBuilderDefault(s))) === "team");
    expect(team.length).toBeGreaterThan(0);
    let checked = 0;
    for (const sport of team) {
      const d = new FakePadDriver();
      const kinds: string[] = [];
      const add = d.addEntrants.bind(d);
      d.addEntrants = (id, es) => { kinds.push(...es.map((e) => e.kind)); return add(id, es); };
      const r = await run(d, sport);
      expect(kinds, sport).toEqual(["team", "team", "team"]);
      expect(r.state, sport).toBe("works");
      // The other direction: LIFECYCLE on the same sport is still the W1-driving deferral, before any driver call.
      const l = new FakePadDriver();
      await expect(SCENARIOS.LIFECYCLE.run({ ...ctxOf(l, sport), spec: { ...ctxOf(l, sport).spec, scenario: "LIFECYCLE" } }), sport).rejects.toMatchObject({ name: "ScenarioUnsupported", message: "team rosters" });
      expect(l.calls, sport).toEqual([]);
      checked++;
    }
    expect(checked).toBe(team.length);
  });

  it("a sport with no pad adapter is refused by name (NoPadAdapter), naming the task that owes it, before any driver call", async () => {
    const d = new FakePadDriver();
    // Since W1c Task 11 every catalogue sport has an adapter (carry f), so the
    // refusal is reached with a sport the catalogue does not have.
    const sport = "curling";
    expect(PAD_SPORTS).not.toContain(sport);
    expect(SPORT_KEYS).not.toContain(sport);
    const base = ctxOf(d, "generic");
    const err = await padProof.run({ ...base, spec: { ...base.spec, caseId: `league|${sport}|x|PADPROOF`, sport } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NoPadAdapter);
    expect(err).not.toBeInstanceOf(ScenarioUnsupported);
    expect((err as Error).message).toContain(noPadReason(sport));
    expect(d.calls).toEqual([]);
  });

  it("carry (f): NoPadAdapter is unreachable for every catalogue sport — each passes the PAD_SPORTS gate (11 checked)", async () => {
    let checked = 0;
    for (const sport of SPORT_KEYS) {
      const d = new FakePadDriver();
      const err = await padProof.run(ctxOf(d, sport)).catch((e: unknown) => e);
      expect(err, sport).not.toBeInstanceOf(NoPadAdapter);
      checked++;
    }
    expect(checked).toBe(11);
  });
});

describe("the pad-proof set", () => {
  it("is registered: PADPROOF scores every fixture on the pad (padPolicy all), and the W1a slice never plans it", () => {
    expect(padProof.key).toBe("PADPROOF");
    expect(padProof.padPolicy).toBe("all");
    expect(SCENARIO_KEYS).not.toContain("PADPROOF");
    // Every other scenario keeps the default (first).
    for (const k of Object.keys(SCENARIOS)) if (k !== "PADPROOF") expect(SCENARIOS[k as keyof typeof SCENARIOS].padPolicy, k).toBeUndefined();
  });

  it("plans one league case per pad sport, in PAD_SPORTS order, at the DB's builder default; needs the browser; takes no filter", () => {
    expect(PAD_PROOF_SET).toBe("pad-proof");
    const p = padProofPlanner({});
    expect(p.sports).toEqual(PAD_SPORTS);
    expect(p.deniesFeatures).toBe(false);
    expect(p.needsBrowser).toBe(true);
    const asked: string[] = [];
    const cases = p.plan((s) => { asked.push(s); return `v-${s}`; });
    expect(cases.length).toBe(PAD_SPORTS.length);
    expect(asked).toEqual([...PAD_SPORTS]);
    expect(cases).toEqual(PAD_SPORTS.map((sport) => ({ caseId: `league|${sport}|v-${sport}|PADPROOF`, row: "league", sport, variant: `v-${sport}`, scenario: "PADPROOF", canary: false })));
    for (const cli of [{ only: "league|generic" }, { scenario: "LIFECYCLE" }, { canary: "M1" }]) expect(() => padProofPlanner(cli), JSON.stringify(cli)).toThrow(SetTakesNoFilter);
  });
});
