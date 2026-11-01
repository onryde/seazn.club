// Match Day E1 item 3 (owner 2026-11-01): where a stage's bracket tree is drawn.
//
// `BracketPanel` draws four shapes, detected the way it detects them (`bracket-panel.tsx`): a page playoff, a stepladder rung list, a
// two-sided single-elimination tree, and the two-lane double-elimination layout. The single-elimination shapes (and the page playoff, a
// four-team tree) are expanded INLINE in the stage's card from its header's "Bracket" button; the double-elimination layout and the
// stepladder keep the page-level view above the cards they always had. One predicate, so the card's button and the page's mount cannot
// disagree about who draws what: a stage is drawn in exactly ONE of the two places, or in neither (no bracket generated yet).
import { doubleElimBracket, pagePlayoffBracket, twoSidedBracket, type BracketFixtureRef } from "@seazn/engine/scheduling/bracket-layout";
import { BRACKET_STAGE_KINDS } from "@/lib/run-sheet-groups";

/** `card`: the Bracket button on the stage's card opens the tree. `page`: the tree stays above the cards. `null`: nothing to draw. */
export type BracketPlacement = "card" | "page" | null;

/** Mirrors `BracketPanel`'s own branch order, so a placement of `card` or `page` is a promise that the panel renders a tree for it. */
export function bracketPlacement(kind: string, fixtures: readonly BracketFixtureRef[]): BracketPlacement {
  // Only a bracket-kind stage draws a tree at all: a league whose rows happen to be tree-shaped is still a league.
  if (!BRACKET_STAGE_KINDS.has(kind)) return null;
  if (kind === "page_playoff") return pagePlayoffBracket(fixtures).ok ? "card" : null;
  if (kind === "stepladder") return fixtures.length === 0 ? null : "page"; // the rung list draws nothing until rungs exist
  if (twoSidedBracket(fixtures).ok) return "card";
  return doubleElimBracket(fixtures).ok ? "page" : null;
}
