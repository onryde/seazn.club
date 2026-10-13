// The sport events a bare Start can be followed by, per sport, drawn from each module's OWN declarations — the events
// its generator (`arbitraryEvent`) draws and the live actions its pad declares (`padSpec`) — never a typed table of
// payloads. Shared by ruling 114's sweep (core/forfeit-ruling-114.test.ts, where it was written) and ruling 120's
// (sport/player-stats-ruling-120.test.ts): a non-scoring event is play (ruling 114), before a forfeit or an abandon.
import { foldMatchWithStoppage, isCoreEventType, outcomeOf, type EventEnvelope } from "../core/events.ts";
import { mulberry32 } from "../core/rng.ts";
import type { LineupPair } from "../core/types.ts";
import { buildPathObject, type AnySportModule, type PadAction } from "../sport/module.ts";
import { declaredCfgs } from "./declared-cfgs.ts";
import { defaultLineupPair, makeEnvelope } from "./helpers.ts";

/** Generator seeds per declared cfg. Cricket draws its interruption from a 0.4% roll of its per-ball branch, so the
 *  sweep looks further than `onePlayEvent`'s 64. */
const SEEDS = 2048;

const START = (): EventEnvelope => makeEnvelope(1, { type: "core.start", payload: {} });
const fold = (m: AnySportModule, cfg: unknown, l: LineupPair, events: EventEnvelope[]) => foldMatchWithStoppage(m as never, cfg as never, l, events);

/** The module's two readings of the score (as testkit/play-event.ts reads them, R112 review M-2): the summary's
 *  per-side score line, and the played tally — the credit a bye earns (C-5). */
const scoreOf = (m: AnySportModule, cfg: unknown, state: unknown): string =>
  JSON.stringify([m.summary(state as never).perSide.map((s) => s.line), m.forfeitCredit(cfg, state, "bye", "home").perSide]);

export type Scene = { sport: string; cfgName: string; cfg: unknown; l: LineupPair; event: EventEnvelope; scoring: boolean; source: "generator" | "pad" };

/** A live pad action's payload built from its OWN field declarations alone (padSpec: an enum's first value, a required
 *  number's minimum, a toggle off), or null when the action needs a side or a person collected (its attribution). */
function padPayload(action: PadAction): Record<string, unknown> | null {
  if (action.attribution.some((a) => a.required === true)) return null;
  const entries: [string, unknown][] = [];
  for (const f of action.fields) {
    if (f.kind === "enum") entries.push([f.path, f.values[0]]);
    else if (f.kind === "number") { if (f.optional !== true) entries.push([f.path, f.min]); }
    else if (f.optional !== true) entries.push([f.path, false]);
  }
  return buildPathObject(entries);
}

/** Every distinct sport event type that can follow a bare Start, per sport (first declared cfg that reaches it), from
 *  the module's declarations only: the events its generator (`arbitraryEvent`) draws, then the live actions its pad
 *  declares (`padSpec`) — cricket's generator, for one, opens an innings before it can draw a rain delay, which its pad
 *  offers from the Start. Each is module-owned, DECLARED in its eventSchemas, accepted strictly as the next event, and
 *  leaves the match undecided. `scoring` is whether it moves the score line or the played tally. */
export function reachableAfterStart(m: AnySportModule): Scene[] {
  const schemas = (m as { eventSchemas?: Record<string, { safeParse(x: unknown): { success: boolean } }> }).eventSchemas ?? {};
  const l = defaultLineupPair(m.positions);
  const seen = new Map<string, Scene>();
  for (const { name, cfg } of declaredCfgs(m as never)) {
    const state = fold(m, cfg, l, [START()]).state;
    const before = scoreOf(m, cfg, state);
    const tryEvent = (drawn: { type: string; payload: unknown }, source: Scene["source"]) => {
      if (isCoreEventType(drawn.type) || seen.has(drawn.type)) return;
      if (schemas[drawn.type] === undefined) throw new Error(`${m.key}: its ${source} names ${drawn.type}, which it does not declare`);
      const event = makeEnvelope(2, drawn);
      let folded;
      try {
        folded = foldMatchWithStoppage(m as never, cfg as never, l, [START(), event], { strictFromSeq: 2 });
      } catch {
        return;
      }
      if (outcomeOf(m as never, folded as never) !== null) return;
      seen.set(drawn.type, { sport: m.key, cfgName: name, cfg, l, event, scoring: scoreOf(m, cfg, folded.state) !== before, source });
    };
    for (let seed = 1; seed <= SEEDS; seed++) {
      const drawn = m.arbitraryEvent?.(state, mulberry32(seed));
      if (drawn !== null && drawn !== undefined) tryEvent(drawn, "generator");
    }
    for (const panel of m.padSpec?.(cfg).panels ?? []) {
      if (panel.phase !== "live") continue;
      for (const action of panel.actions) {
        const payload = padPayload(action);
        if (payload !== null && schemas[action.type]?.safeParse(payload).success === true) tryEvent({ type: action.type, payload }, "pad");
      }
    }
  }
  return [...seen.values()];
}
