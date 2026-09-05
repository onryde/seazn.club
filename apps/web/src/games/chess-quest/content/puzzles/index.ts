// Chess Quest puzzle packs — one file per family under this directory so
// packs can be authored independently. Every entry is machine-verified by
// content/__tests__/puzzles.test.ts; do not edit data to make tests pass.
// The original packs were transcribed verbatim from the original app
// (chess-quest js/puzzles.js) and later extended.
export type { MatePuzzle, HuntPuzzle, TacticPuzzle } from "./types";
export { MATE1 } from "./mate1";
export { MATE2 } from "./mate2";
export { MATE3 } from "./mate3";
export { HUNTS } from "./hunts";
export { TACTICS } from "./tactics1";
export { TACTICS2 } from "./tactics2";
export { TACTICS3 } from "./tactics3";
export { TACTICS4 } from "./tactics4";
export { TACTICS5 } from "./tactics5";
