import "server-only";
// Who serves next in a set-based match, for a reader with no pad (task A3 fix round 2, S1: Match Day's playing court).
//
// The answer is the ENGINE's: `setBasedServeContext(module, state, events)`, the same call the pad makes
// (components/v2/scorepad/v3/skins/badminton.tsx `serveContextOf`), over the fixture's whole ledger and its fold. The server is
// in neither the summary nor the stored state (it is a reading of the rally order, BWF Law 10.1, re-anchored at each set), so it
// is never derived here by a rule of our own. The state it reads is the one `foldFixture` builds — the same fold the write path
// stores — with the squads the pad hands it (`state.squads`, else `initSquads(lineups)`: types.ts `PadHostView.squads`).
//
// Which sports: those whose module declares a serve rotation (`SetBasedServeSource`), read off the module itself — a sport that
// starts declaring one joins without a list here. Any other sport, no ledger, or an engine that will not say: null.
import type postgres from "postgres";
import { initSquads } from "@seazn/engine/core";
import type { AnySportModule } from "@seazn/engine/sport";
import { setBasedServeContext, type SetBasedServeSource, type SetBasedState } from "@seazn/engine/sports/setbased";
import { foldFrom, loadFoldInputs } from "./fold";
import { resolveLatestModule } from "./registry";

type Tx = postgres.TransactionSql;

/** A module the serve reader can read: it declares its rotation and its coarse event (`SetBasedServeSource`). */
export function readsServe(module: AnySportModule): module is AnySportModule & SetBasedServeSource {
  const m = module as Partial<Record<keyof SetBasedServeSource, unknown>>;
  return typeof m.serveRotation === "object" && m.serveRotation !== null && typeof m.coarseEventType === "string";
}

/** Whether a sport's matches can say who serves: its current module declares a serve rotation. A cheap gate before a fold. */
export function sportReadsServe(sportKey: string): boolean {
  return readsServe(resolveLatestModule(sportKey));
}

/** The side due to serve the next rally of `fixtureId`, as the engine says it; null when its sport has no serve reader, it has
 *  no ledger, or the engine does not know (`serveOrderKnown === false` — never a guess in its place). */
export async function servingSideOf(tx: Tx, fixtureId: string): Promise<"home" | "away" | null> {
  const inputs = await loadFoldInputs(tx, fixtureId);
  if (inputs === null || !readsServe(inputs.module)) return null;
  const folded = foldFrom(fixtureId, inputs);
  const state = folded.state as SetBasedState;
  const ctx = setBasedServeContext(inputs.module, { ...state, squads: state.squads ?? initSquads(inputs.lineups) }, inputs.envelopes);
  return ctx.side;
}
