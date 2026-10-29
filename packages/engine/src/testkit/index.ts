// @seazn/engine/testkit — conformance suite factories for module authors —
// spec 03 §2 (kernel guarantees), §6 (determinism & simulation), spec 04 §9
// (cross-sport invariants) — plus the tournament simulation harness
// (PROMPT-14): full-division property simulation across every stage-graph
// template, with seeded exact replay (sim:replay).

export * from "./helpers.ts";
export * from "./conformance.ts";
export * from "./simulation.ts";
// W4 (#407) — stoppage-bearing stream generation. Pure: no node:fs, so unlike
// the two disk-reading testkit modules it belongs in the published barrel.
export * from "./stoppages.ts";
// R26 (format-matrix W1b) — the shared sport sweep. Pure, so it belongs here.
export * from "./for-each-sport.ts";
// W2a (preflight C7) — the declared cfgs every W2a sport sweep walks. Pure.
export * from "./declared-cfgs.ts";
// W2b ruling 112 — one real sport event, drawn from the module's own generator. Pure.
export * from "./play-event.ts";
// W2e X-SE-2 (preflight D-2) — "a sanction alone moves no score", the one sweep body the cross-sport and per-sport rows run. Pure.
export * from "./sanction-score.ts";
// Engine-split 1d-5 (R12) — the rules reference parser (`rules/*.md` rows). It reads the disk, which this barrel otherwise
// never does, because `rules/` ships in the package; the barrel's disk-reading closure is pinned to this one module by a test.
export * from "./rules-reference.ts";
