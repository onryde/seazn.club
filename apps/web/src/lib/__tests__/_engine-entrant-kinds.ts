// The entrant kinds a sport's ENGINE model declares (`effectiveEntrantModel(module.entrantModel, null).kinds`) - what
// the division builder's page and the Settings page hand the format offer (templatesForSport, Match Day C9 fix round 1
// I5). A test fixture reads the engine's declaration here rather than typing a kinds list per sport.
import { builtinModules } from "@seazn/engine/sports";
import { effectiveEntrantModel } from "@seazn/engine/sport";

export function engineEntrantKinds(sportKey: string): readonly string[] {
  const m = builtinModules.find((x) => x.key === sportKey);
  if (m === undefined) throw new Error(`engineEntrantKinds: no engine module '${sportKey}'`);
  return effectiveEntrantModel(m.entrantModel ?? null, null).kinds;
}

/** The `entrants` a division builder SportOption carries for this sport, as the page builds it (`d/new/page.tsx`: the
 *  engine's effective model, kinds and default kind). */
export function engineEntrantChoice(sportKey: string): { kinds: readonly ("team" | "individual" | "pair")[]; defaultKind: "team" | "individual" | "pair" } {
  const m = builtinModules.find((x) => x.key === sportKey);
  if (m === undefined) throw new Error(`engineEntrantChoice: no engine module '${sportKey}'`);
  const model = effectiveEntrantModel(m.entrantModel ?? null, null);
  return { kinds: model.kinds, defaultKind: model.defaultKind };
}
