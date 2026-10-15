// W2c Task 13b (R-13b-1; D3) — every whole decider any sport declares (`decider: true`, over every kind and variant),
// the set a stage's config refuses at its TOP level. A stage carries its deciders under `config.rules` only; one at the
// top is read by nothing (stage-cfg.ts), so it is a client's mistake, refused by name rather than silently ignored.
//
// ONE authority for both refusals that use it: the create door (`usecases/stage-defaults.ts`, any caller) and the API
// schema (`api-v1/schemas.ts`, `StageConfig` / `PutStageRules`, whose `z.never` message `http.ts` turns into a named
// 400). From the engine's declarations, never a list kept here: a decider a sport adds is refused at both with no edit.
//
// Loaded bare by `scripts/openapi-gen.ts` (node --experimental-strip-types, no resolver) through schemas.ts: bare
// package imports only, no `@/`, no JSX. That no decider collides with a stage config key of its own is a guard in
// usecases/__tests__/stage-defaults.test.ts.
import { deciderKeysFor } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";

/** Sorted, unique. */
export const TOP_LEVEL_STAGE_DECIDERS: readonly string[] = [...new Set(builtinModules.flatMap((m) => deciderKeysFor(m, null, null)))].sort();
