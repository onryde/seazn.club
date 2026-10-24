// @seazn/engine/sport — SportModule contract, registry, position catalog (spec 03 §1).

export * from "./module.ts";
export * from "./registry.ts";
export * from "./catalog.ts";
export * from "./entrant-model.ts";
export * from "./fold-epoch.ts";
// W2c (spec §4.1 as amended) — who may set a cfg key, at which scope, for which stage kind and variant.
export * from "./rule-keys.ts";
// W2c owner P-5 - the sentences a cfg that cannot share points on an abandon is refused with (generic and carrom), so a
// client can map each to its own localized copy rather than show the English wire text.
export * from "./abandon-share.ts";
