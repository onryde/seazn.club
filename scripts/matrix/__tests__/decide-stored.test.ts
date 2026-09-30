// decideFixture folds what the product STORED on the pad path (W1c Task 7):
// the ledger rows the taps wrote, never the stream the harness meant to send.
// The pad fake (fake-pad-driver.ts) answers every event with `stored`; its
// storedAs seam makes the pad write something else, which is the only case
// where the two folds differ and so the only one that can witness the rule.
import { describe, expect, it } from "vitest";
import { foldStream } from "../lib/fold.ts";
import { toObservedOutcome } from "../lib/observed.ts";
import { Recorder, decideFixture, setUpDivision } from "../lib/scenarios/common.ts";
import type { CaseSpec, ScenarioContext } from "../lib/scenarios/types.ts";
import { resolveSportCfg, sportModule } from "../lib/sport-cfg.ts";
import { generateStream } from "../lib/streams/index.ts";
import type { StreamEvent } from "../lib/streams/types.ts";
import { offlineBuilderDefault } from "../lib/variants.ts";
import { FakeLeagueDriver } from "./fake-driver.ts";
import { FakePadDriver } from "./fake-pad-driver.ts";

// Badminton: a set summary is the event whose numbers a pad can get wrong.
const SPORT = "badminton";
const VARIANT = offlineBuilderDefault(SPORT);
const CFG = resolveSportCfg(SPORT, VARIANT);

function ctxOf(driver: FakeLeagueDriver): ScenarioContext {
  const spec: CaseSpec = { caseId: `league|${SPORT}|${VARIANT}|PADPROOF`, row: "league", sport: SPORT, variant: VARIANT, scenario: "LIFECYCLE", canary: false };
  return { driver, spec, orgSlug: "o", cfg: CFG, tag: "t", denied: [] };
}

/** One fixture decided for home: the recorder, the fixture and what the harness meant to send. */
async function decideOne(driver: FakeLeagueDriver) {
  const ctx = ctxOf(driver);
  const rec = new Recorder();
  const setup = await setUpDivision(ctx, rec, 3);
  const f = (await driver.listFixtures(setup.division.id)).sort((a, b) => (a.fixture_no ?? 0) - (b.fixture_no ?? 0))[0]!;
  const meant = generateStream({ sportKey: SPORT, cfg: CFG, stageKind: "league", home: f.home_entrant_id!, away: f.away_entrant_id!, outcome: { kind: "win", winner: "home" } });
  await decideFixture(ctx, rec, setup, f, { kind: "win", winner: "home" });
  return { rec, f, meant };
}

/** A pad that writes every set summary with the sides swapped. */
const swapped = (evs: readonly StreamEvent[]) => evs.map((e) => {
  if (e.type !== `${SPORT}.${sportModule(SPORT).coarseEventType}`) return e;
  const p = e.payload as { home: number; away: number };
  return { type: e.type, payload: { home: p.away, away: p.home } };
});

describe("decideFixture folds the stored stream", () => {
  it("when every PostedEvent carries `stored`, the stored rows are folded and recorded as the fixture's stream", async () => {
    const d = new FakePadDriver();
    d.storedAs = swapped;
    const { rec, f, meant } = await decideOne(d);
    const stored = swapped(meant);
    // The two folds differ: the pad wrote an away win, the harness meant a home win.
    const home = f.home_entrant_id!;
    const away = f.away_entrant_id!;
    const meantFold = foldStream(sportModule(SPORT), CFG, home, away, meant).outcome;
    const storedFold = foldStream(sportModule(SPORT), CFG, home, away, stored).outcome;
    expect(toObservedOutcome(meantFold)).not.toEqual(toObservedOutcome(storedFold));
    expect(rec.streams.get(f.id)).toEqual(stored);
    expect(rec.parity).toHaveLength(1);
    expect(rec.parity[0]).toMatchObject({ fixtureId: f.id, local: toObservedOutcome(storedFold), product: toObservedOutcome(storedFold), foreign: 0, request: "mismatch" });
    expect(rec.storedFixtures.has(f.id)).toBe(true);
    // Counts stay the harness's intended events (counts.events' meaning).
    expect(rec.events).toBe(meant.length);
  });

  it("a pad that wrote what it was asked folds to the requested outcome, and is recorded as stored", async () => {
    const { rec, f, meant } = await decideOne(new FakePadDriver());
    expect(rec.streams.get(f.id)).toEqual(meant);
    expect(rec.parity[0]).toMatchObject({ fixtureId: f.id, request: "match", foreign: 0 });
    expect(rec.storedFixtures.has(f.id)).toBe(true);
  });

  it("without `stored` (the http path) decideFixture is unchanged: the sent stream is folded, and nothing is marked stored", async () => {
    const { rec, f, meant } = await decideOne(new FakeLeagueDriver());
    expect(rec.streams.get(f.id)).toEqual(meant);
    expect(rec.parity[0]).toMatchObject({ fixtureId: f.id, request: "match", foreign: 0 });
    expect(rec.storedFixtures.size).toBe(0);
  });

  it("a driver that answered no event for a non-empty stream folds nothing (never the stream it meant), and says so", async () => {
    const d = new FakeLeagueDriver();
    d.postStream = () => Promise.resolve([]);
    const { rec, f, meant } = await decideOne(d);
    expect(meant.length).toBeGreaterThan(0);
    expect(rec.streams.get(f.id)).toEqual([]);
    expect(rec.parity[0]).toMatchObject({ fixtureId: f.id, local: null, request: "mismatch" });
    expect(rec.notes).toContain(`${f.id}: the driver answered no event for the ${meant.length} sent`);
  });

  it("a driver that answers `stored` on some events and not others is refused by name (every event from the ledger, or none)", async () => {
    const d = new FakePadDriver();
    const post = d.postStream.bind(d);
    d.postStream = async (id, evs, p) => (await post(id, evs, p)).map((x, i) => {
      if (i !== 0) return x;
      const { stored: _dropped, ...http } = x;
      return http;
    });
    await expect(decideOne(d)).rejects.toThrow(/answered event\(s\) carry the stored row/);
  });
});
