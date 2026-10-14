// W2c Task 12 (X-SR-6): a new bracket stage starts with its sport's deciders ON — football's extra time and penalties,
// ice hockey's overtime and shoot-out, hockey's shoot-out, the limited-overs super over. A rig whose premise is a level
// knockout HELD for the organiser (needs_decision) creates its stage with every decider switched OFF: the X-SR-6 "every
// decider off" path, which is a state an organiser reaches on purpose.
//
// Off is `false` for a decider whose engine off is null (the period sports' overtime and shoot-out, fix round 1 R-T12-1:
// a stage's null means inherit, so it cannot say off) — the same question the resolver asks (`lib/stage-decider-off.ts`)
// — and otherwise the division variant's own value (football's and cricket's booleans, off in every variant).
//
// From the engine's declarations (`deciderKeysFor`, the variant's own parsed config), never a literal typed here. Its own
// file, not helpers.ts: that one deliberately pulls nothing of the app's runtime in, and this reads the engine.
import { deciderKeysFor, type AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import type { StageKind } from "@seazn/engine/core";
import { offByFalse } from "../src/lib/stage-decider-off";

/** `config.rules` for a stage of `kind` with every decider off: `false` where the engine's off is null, else the division
 *  variant's own value. Throws for a sport or variant the engine does not declare. */
export function decidersOffRules(sport: string, variant: string, kind: StageKind = "knockout"): Record<string, unknown> {
  const m = builtinModules.find((x) => x.key === sport) as AnySportModule | undefined;
  if (m === undefined || !Object.hasOwn(m.variants, variant)) throw new Error(`decidersOffRules: no ${sport}/${variant}`);
  const division = m.configSchema.parse(m.variants[variant]) as Record<string, unknown>;
  return Object.fromEntries(deciderKeysFor(m, kind, variant).map((k) => [k, offByFalse(m, division, k) ? false : (division[k] ?? null)]));
}
