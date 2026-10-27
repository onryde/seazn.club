// @seazn/engine/competition — sport-agnostic competition engine (spec 03 §4).

export * from "./stage.ts";
export * from "./standings.ts";
export * from "./tiebreakers.ts";
export * from "./progression.ts";
export * from "./display.ts";
export * from "./points.ts";
export * from "./round-role.ts";
export * from "./qualification.ts";
export * from "./tie-what-if.ts";
// W2d (spec §5.2) — how a decided match was decided (`decidedInFor`).
export * from "./decided-in.ts";
// W2d (spec §5.5) — the tie-break order's write-side rules (`validateCascade`, `offerableKeys`).
export * from "./cascade-rules.ts";
// W2d (spec §5.4, §5.9) — the one resolver of a stage's table rules (`resolveTableRules`, `defaultCrossGroup`).
export * from "./table-rules.ts";
