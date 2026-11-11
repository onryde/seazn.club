// W4 app B, B5b Task 13 (X-CH-1, X-CH-3, X-CH-4; owner pick 3A) - what a bracket's DECIDING FINAL's tile says in place of a
// score: "Joint winners" (the organiser ruled it, `joint_winners_at`) or "Title vacant" (both finalists walked from it, a
// double walkover). One reader for every tile surface (the organiser's bracket and the public one), so the two cannot
// disagree about which final is which. It reads the fixture's own row, the same facts `bracketTitleOf`
// (`server/public-site/champion.ts`) crowns from, and names no entrant: the page banner names the pair.
//
// Client-safe: no server import.
import { creditsNobody } from "@/lib/forfeit-tag";

export type FinalTitleTag = "joint" | "vacant";

/** The statuses that settle a bracket game, in the DB's vocabulary (champion.ts's BRACKET_SETTLED; a test keeps the two equal). */
export const TITLE_SETTLED_STATUSES: ReadonlySet<string> = new Set(["decided", "finalized", "forfeited"]);

export interface FinalTitleFixture {
  is_final?: boolean | null;
  third_place?: boolean | null;
  status: string;
  outcome: unknown;
  joint_winners_at?: string | null;
}

export function finalTitleTag(f: FinalTitleFixture): FinalTitleTag | null {
  // A deciding final only: a bronze match or a semi-final that carries a double walkover is NOT a vacant title.
  if (f.is_final !== true || f.third_place === true) return null;
  if (!TITLE_SETTLED_STATUSES.has(f.status)) return null;
  if (f.joint_winners_at != null) return "joint";
  if (creditsNobody(f.outcome)) return "vacant";
  return null;
}
