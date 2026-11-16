import { tennisPadRules } from "@seazn/engine/pad";
import type { TennisRules } from "./tennis-match";

/**
 * The rules the tennis demo plays to, from the engine's own declarations: how points are called and how many sets a
 * match is. SERVER ONLY, like rally-rules.ts.
 */
export const TENNIS_RULES: TennisRules = { calls: [...tennisPadRules.pointCalls], bestOf: tennisPadRules.bestOf({}) };
