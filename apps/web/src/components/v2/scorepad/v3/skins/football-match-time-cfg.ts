// Football's match-time cfg, parsed as the engine parses it (S2-5 ruling 108).
//
// Split from `football-match-time.ts` (S2-5 final review I1) because this is
// the one piece of match time that needs the engine's football module, and
// that module must not reach the OBS overlay's browser bundle. Import this
// from the pad's skin (`football.tsx`) and the server's overlay projection
// (`server/overlay/project.ts`) only; the overlay reads the parsed numbers
// off the wire.
import { FootballCfg } from "@seazn/engine/sports/football";
import type { MatchTimeCfg } from "./football-match-time";

/** A view's `cfg`, parsed as the engine parses it. A cfg the engine refuses
 *  reads as the engine's defaults (2 × 45), so the clock still shows a time. */
export function matchTimeCfgOf(cfg: unknown): MatchTimeCfg {
  const parsed = FootballCfg.safeParse(cfg);
  return parsed.success ? parsed.data : FootballCfg.parse({});
}
