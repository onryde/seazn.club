// Daily Word engine -- pure functions only, no DOM, no localStorage. The
// duplicate-letter handling in evaluate() is the one thing this genre is
// famous for getting wrong; see the header comment on evaluate() itself in
// ../engine.ts for the two-pass algorithm this table locks in.
import { describe, expect, it } from "vitest";
import {
  answerFor,
  evaluate,
  isValidGuess,
  keyStatuses,
  puzzleNumber,
  shareText,
  todayISO,
} from "../engine";
import { ANSWERS } from "../content/answers";

describe("evaluate", () => {
  it("marks every letter hit when the guess equals the answer", () => {
    expect(evaluate("LEVEL", "LEVEL")).toEqual(["hit", "hit", "hit", "hit", "hit"]);
  });

  it("marks every letter miss when no letters overlap at all", () => {
    expect(evaluate("CRISP", "MOUND")).toEqual(["miss", "miss", "miss", "miss", "miss"]);
  });

  it("the classic double-letter bug: ALLEY vs LEVEL", () => {
    // answer LEVEL has two L's (pos 0, 4) and two E's (pos 1, 3); guess ALLEY
    // has two L's (pos 1, 2), one A, one E, one Y. Position 3 (E vs E) is
    // the only exact hit. Both guessed L's are "near" (answer has exactly
    // two L's, neither used by a hit) -- a naive "letter appears anywhere in
    // answer" implementation would ALSO mark them near, so this case alone
    // doesn't catch the bug, but combined with the next one it does.
    expect(evaluate("ALLEY", "LEVEL")).toEqual(["miss", "near", "near", "hit", "miss"]);
  });

  it("does not over-count a repeated guess letter against a single answer copy: SPEED vs ABIDE", () => {
    // Answer ABIDE has exactly ONE E (position 4). Guess SPEED has TWO E's
    // (positions 2 and 3). A naive implementation marks BOTH E's "near"
    // (since E "appears in the answer"); the correct two-pass algorithm
    // marks only the first (left-to-right) "near" and the second "miss",
    // because after the first E consumes the answer's only E, none remain.
    expect(evaluate("SPEED", "ABIDE")).toEqual(["miss", "miss", "near", "miss", "near"]);
  });

  it("hits and nears together without double-counting: ROBOT vs MOTOR", () => {
    // Both words share R, O, O, T but in different arrangements. Position 1
    // and 3 (O vs O) are exact hits; guess's R (pos 0) and T (pos 4) are
    // each near (answer has one R and one T left over, unclaimed by a hit).
    expect(evaluate("ROBOT", "MOTOR")).toEqual(["near", "hit", "miss", "hit", "near"]);
  });

  it("is case-insensitive", () => {
    expect(evaluate("level", "LEVEL")).toEqual(["hit", "hit", "hit", "hit", "hit"]);
    expect(evaluate("LEVEL", "level")).toEqual(["hit", "hit", "hit", "hit", "hit"]);
  });
});

describe("isValidGuess", () => {
  it("accepts a word from ANSWERS", () => {
    expect(isValidGuess("ABOUT")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isValidGuess("about")).toBe(true);
  });

  it("accepts an allowed-only word not in ANSWERS", () => {
    expect(isValidGuess("ABBEY")).toBe(true);
  });

  it("rejects a non-word", () => {
    expect(isValidGuess("ZZZZZ")).toBe(false);
  });

  it("rejects the wrong length", () => {
    expect(isValidGuess("AB")).toBe(false);
    expect(isValidGuess("ABOUTS")).toBe(false);
  });
});

describe("answerFor", () => {
  it("is stable: same date always returns the same answer", () => {
    const a = answerFor("2026-08-27");
    const b = answerFor("2026-08-27");
    expect(a).toBe(b);
  });

  it("always returns a word from ANSWERS", () => {
    expect(ANSWERS).toContain(answerFor("2026-08-27"));
    expect(ANSWERS).toContain(answerFor("2027-01-01"));
  });

  it("defaults to today without throwing", () => {
    expect(() => answerFor()).not.toThrow();
    expect(ANSWERS).toContain(answerFor());
  });
});

describe("todayISO", () => {
  it("returns an ISO calendar-date string (YYYY-MM-DD)", () => {
    expect(todayISO()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("matches the local date the same way chess-quest's progress.tsx computes it", () => {
    const d = new Date();
    const expected =
      d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    expect(todayISO()).toBe(expected);
  });
});

describe("puzzleNumber", () => {
  it("is 1 on the launch date", () => {
    // Keep in sync with engine.ts's LAUNCH_DATE constant.
    expect(puzzleNumber("2026-08-27")).toBe(1);
  });

  it("increments by exactly one per calendar day", () => {
    expect(puzzleNumber("2026-08-28")).toBe(2);
    expect(puzzleNumber("2026-08-29")).toBe(3);
  });

  it("is monotonically increasing across a month boundary", () => {
    expect(puzzleNumber("2026-09-01")).toBeGreaterThan(puzzleNumber("2026-08-31"));
  });
});

describe("keyStatuses", () => {
  it("maps every letter of a fully-correct guess to hit", () => {
    expect(keyStatuses(["LEVEL"], "LEVEL")).toEqual({ L: "hit", E: "hit", V: "hit" });
  });

  it("maps miss and near correctly for a single guess", () => {
    // CRISP vs MOUND -> all miss (no shared letters)
    expect(keyStatuses(["CRISP"], "MOUND")).toEqual({
      C: "miss",
      R: "miss",
      I: "miss",
      S: "miss",
      P: "miss",
    });
  });

  it("never downgrades a letter's best-seen status across multiple guesses", () => {
    // First guess sees 'near' for R against MOTOR (no hit), second guess
    // sees 'hit' for the same letter -- the map must report 'hit', not
    // whatever the first guess saw.
    const statuses = keyStatuses(["ARISE", "MOTOR"], "MOTOR");
    expect(statuses.R).toBe("hit");
  });
});

describe("shareText", () => {
  it("matches the exact 'Seazn Word #N x/6' header format on a win", () => {
    const text = shareText(12, ["MOTOR"], "MOTOR");
    expect(text.startsWith("Seazn Word #12 1/6")).toBe(true);
  });

  it("shows X/6 on a loss (6 guesses, none correct)", () => {
    const text = shareText(12, ["CRISP", "CRISP", "CRISP", "CRISP", "CRISP", "CRISP"], "MOTOR");
    expect(text.startsWith("Seazn Word #12 X/6")).toBe(true);
  });

  it("never includes any guessed letters -- emoji grid only", () => {
    const text = shareText(12, ["ROBOT", "MOTOR"], "MOTOR");
    expect(text).not.toContain("ROBOT");
    expect(text).not.toContain("MOTOR");
    expect(text).toMatch(/[\u{1F7E9}\u{1F7E8}\u{2B1B}]/u); // at least one of 🟩🟨⬛
  });

  it("emits one emoji-grid line per guess", () => {
    const text = shareText(1, ["ROBOT", "MOTOR"], "MOTOR");
    const gridLines = text
      .split("\n")
      .filter((l) => /^[\u{1F7E9}\u{1F7E8}\u{2B1B}]+$/u.test(l));
    expect(gridLines).toHaveLength(2);
  });
});
