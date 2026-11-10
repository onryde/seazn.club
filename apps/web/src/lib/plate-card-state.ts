// W4 app PR B, Task 8 (X-PL-5, X-PL-2): what the plate's stage card says before and after its field is known. The plate has no
// lines day one, so the proposal panel (components/v2/progression-panel.tsx) cannot wait on "the source stage completed": it is told
// by the server, from the main draw's own first-loss field (`plateCardStateOf`, server/usecases/plate-field.ts).
//   waiting   - some first matches are still to play: `done` of `total` are decided (the card's progress line).
//   ready     - every first match is decided: the proposal exists, or is computable (the empty card offers Compute).
//   too_small - the plate completed by name with fewer than two first-match losers (X-PL-2): nothing to draw, nothing owed.
export type PlateCardState = { state: "waiting"; done: number; total: number } | { state: "ready" } | { state: "too_small" };
