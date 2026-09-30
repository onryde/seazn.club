// PADPROOF (W1c D3): the pad itself decides a whole league, and every result is
// then finalized from the console. That puts the fold, the standings and the
// finalize path through the product's own controls. The config is the builder
// default, the one a real organiser gets.
//
// Three entrants make three fixtures. They are decided in fixture order as a home
// win, then a draw where the engine allows one in a league (else an away win),
// then an away win. The scenario claims a pad proof only for what the pad
// stored: pad-stream-stored requires every fixture it decided to be folded from
// the ledger rows (driver PostedEvent.stored). An HTTP driver finalizes too, so
// finalizing alone could never tell the two apart.
import type { StageKind } from "@seazn/engine/core";
import type { FixtureRow } from "../driver/types.ts";
import { isTerminal } from "../observed.ts";
import { PAD_SPORTS, noPadReason } from "../pad-sports.ts";
import { drawsAllowed } from "../sport-cfg.ts";
import type { RequestedOutcome } from "../streams/types.ts";
import { assertion, builtAsPosted, foldParity, loopBounded, resultsAsPosted, stageCompleted, withCanary, type Item } from "./assertions.ts";
import { MAX_ITERATIONS, Recorder, decideFixture, finishStage, recordGenerate, setUpDivision, snapshot } from "./common.ts";
import type { Scenario } from "./types.ts";

export const PAD_PROOF_ENTRANTS = 3;

/** PADPROOF was asked to run a sport with no pad adapter. Nothing plans one:
 *  --set pad-proof plans PAD_SPORTS only and takes no filter. So this is a
 *  harness fault, and it is named rather than deferred. It is also not a
 *  ScenarioUnsupported: the Q-A guard (scenario-catalogue.test.ts) accepts a
 *  deferral only to a wave whose _INDEX status row reads open, and W1c's row
 *  reads "Executing". */
export class NoPadAdapter extends Error {
  readonly sport: string;
  constructor(sport: string) {
    super(`PADPROOF: ${noPadReason(sport)} — --set pad-proof plans only the sports that have one`);
    this.name = "NoPadAdapter";
    this.sport = sport;
  }
}
const seatedOpen = (f: FixtureRow) => f.home_entrant_id !== null && f.away_entrant_id !== null && !isTerminal(f.status);
const byNo = (a: FixtureRow, b: FixtureRow) => (a.fixture_no ?? 0) - (b.fixture_no ?? 0);

/** The outcomes, in decision order: both wins, and a draw where the engine allows one. */
export function padProofPlan(drawOk: boolean): RequestedOutcome[] {
  return [{ kind: "win", winner: "home" }, drawOk ? { kind: "draw" } : { kind: "win", winner: "away" }, { kind: "win", winner: "away" }];
}

export const padProof: Scenario = {
  key: "PADPROOF",
  entrantCount: PAD_PROOF_ENTRANTS,
  canaryCheck: "pad-outcome-as-requested",
  padPolicy: "all",
  async run(ctx) {
    // Fires before the first driver call, like every deferral (common.ts setUpDivision).
    if (!PAD_SPORTS.includes(ctx.spec.sport)) throw new NoPadAdapter(ctx.spec.sport);
    const rec = new Recorder();
    // A team sport's pad is proven on rosterless team entrants (common.ts SetUpOptions).
    const setup = await setUpDivision(ctx, rec, PAD_PROOF_ENTRANTS, { rosterlessTeams: true });
    const plan = padProofPlan(drawsAllowed(ctx.spec.sport, ctx.cfg, setup.stage.kind as StageKind));
    // Every open fixture is tried on the pad ONCE. A pad that leaves one open
    // has already failed its check, and a second attempt would build on a
    // state the stream never meant. The loop drains when nothing untried is
    // left, and life-loop-bounded names any fixture it left unfinished.
    const tried = new Set<string>();
    let ordinal = 0;
    for (let i = 0; ; i++) {
      if (i === MAX_ITERATIONS) { rec.exit = "cap"; rec.facts.add("cut_short"); break; }
      const fixtures = await recordGenerate(ctx, rec, setup.stage.id);
      if (fixtures === null) { rec.exit = "refused_generate"; break; }
      const open = fixtures.filter((f) => seatedOpen(f) && !tried.has(f.id));
      if (open.length === 0) { rec.exit = "drained"; break; }
      const round = Math.min(...open.map((f) => f.round_no ?? 0));
      for (const f of open.filter((x) => (x.round_no ?? 0) === round).sort(byNo)) {
        tried.add(f.id);
        await decideFixture(ctx, rec, setup, f, plan[ordinal++ % plan.length]);
      }
    }
    // Finalize from the console: only a decided fixture offers Finalize.
    const finalized: Item[] = [];
    const finalize = ctx.driver.finalize?.bind(ctx.driver);
    if (finalize === undefined) {
      finalized.push({ ok: false, note: "this driver has no finalize — only the browser driver taps the console's Finalize, so no finalize was proven" });
    } else {
      for (const f of [...await ctx.driver.listFixtures(setup.division.id)].sort(byNo)) {
        if (!tried.has(f.id)) continue;
        const before = await ctx.driver.fixtureState(f.id);
        if (before.status !== "decided") {
          finalized.push({ ok: false, note: `${f.id}: ${before.status}, not decided — the console offers no Finalize` });
          continue;
        }
        const s = await finalize(f.id);
        finalized.push({ ok: s.status === "finalized", note: `${f.id}: ${s.status} after Finalize` });
      }
    }
    const complete = await finishStage(ctx, rec, setup);
    const observed = await snapshot(ctx, rec, setup, { complete, configEdit: null, withdrawal: null });
    const decided = [...tried];
    return {
      observed,
      events: rec.events,
      notes: rec.notes,
      assertions: [
        builtAsPosted(setup.built, observed),
        foldParity(rec),
        resultsAsPosted(rec, observed),
        assertion("pad-stream-stored", decided.map((id) => ({ ok: rec.storedFixtures.has(id), note: `${id}: ${rec.storedFixtures.has(id) ? "folded from the ledger rows the pad wrote" : "folded from the stream the harness sent, not from rows the pad wrote"}` }))),
        assertion("pad-finalized", finalized),
        // The canary adds the deliberately wrong expectation (a mismatch) after the right one, as M1 does.
        assertion("pad-outcome-as-requested", withCanary(
          rec.parity.map((p) => ({ ok: p.request === "match", note: `${p.fixtureId}: request ${p.request ?? "unfolded"}` })),
          rec.parity.map((p) => ({ ok: p.request === "mismatch", note: `${p.fixtureId}: request ${p.request ?? "unfolded"}, expected a mismatch` })),
          ctx.spec.canary,
        )),
        stageCompleted(observed),
        loopBounded(rec, observed),
      ],
    };
  },
};
