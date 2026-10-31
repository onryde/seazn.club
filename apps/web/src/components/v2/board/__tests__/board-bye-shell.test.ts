// W3 Task 3 (X-SW-29, RB3-23): a Swiss bye shell is never on a court. The server refuses to place one
// (`isMovable`, `moveFixture`'s SWISS_BYE_NOT_PLACEABLE); the board is that predicate's client twin (`boardMovable`,
// "the server refuses the rest"), so it must not offer the card a drag, a pin or a place in the unscheduled tray —
// each would be a control that can only refuse. The board read marks the row (`bye_shell`, sent only when true —
// `listDivisionFixturesForBoard`, proven against its real producer in schedule-bye-shell.test.ts).
import { describe, expect, it } from "vitest";
import { boardMovable, inBoardTray } from "../types";

const card = (over: { status?: string; held?: boolean; bye_shell?: boolean; scheduled_at?: string | null } = {}) => ({
  status: "scheduled",
  scheduled_at: null,
  ...over,
});

describe("X-SW-29 the board never offers a Swiss bye shell", () => {
  it("a bye shell is not movable; an ordinary scheduled card is (positive pair); a held card is not", () => {
    expect(boardMovable(card({ bye_shell: true })), "bye shell").toBe(false);
    expect(boardMovable(card()), "a scheduled card").toBe(true);
    expect(boardMovable(card({ held: true })), "a held card (unchanged)").toBe(false);
  });

  it("the unscheduled tray: an untimed scheduled card is in it, an untimed bye shell is not, a timed card is not", () => {
    expect(inBoardTray(card()), "untimed scheduled").toBe(true);
    expect(inBoardTray(card({ bye_shell: true })), "untimed bye shell").toBe(false);
    expect(inBoardTray(card({ scheduled_at: "2030-08-01T09:00:00Z" })), "timed").toBe(false);
    expect(inBoardTray(card({ status: "forfeited" })), "a settled row").toBe(false);
    // A held card keeps its tray place (it is shown, not offered a move) — unchanged by this rule.
    expect(inBoardTray(card({ held: true })), "untimed held").toBe(true);
  });
});
