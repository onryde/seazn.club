// Task 5 fix round 2 (review, Important): whoNames must render a caller-
// supplied WhoLine.servingLabel verbatim, and must NEVER resolve a
// sport-namespaced i18n key itself — that was the defect (reusing
// scorepad.skin.tennis.header.serving inside the shared chassis, a
// primitive every sport's ScorebugSpec renders through; racquet sports
// keep their OWN separate scorepad.skin.racquet.header.serving key
// precisely because one sport's key must not serve another).
//
// Tests whoNames as a plain function — no DOM/render involved, matching
// this repo's apps/web vitest environment:"node" (no jsdom); scorebug.tsx
// itself stays untested by a DOM harness per the original task-5-brief.
import { describe, it, expect } from "vitest";
import { whoNames } from "../scorebug";

describe("whoNames", () => {
  it("folds a servingLabel into the name when serving is true and a label is supplied", () => {
    expect(whoNames([{ name: "Alice", serving: true, servingLabel: "Serving" }])).toBe(
      "Alice, Serving",
    );
  });

  it("renders the bare name when serving is true but NO servingLabel is supplied — no fabricated English", () => {
    // Explicit, stated behaviour (controller's requirement): the chassis
    // never invents copy. Until the skin that built this WhoLine supplies
    // servingLabel, the "serving" fact simply does not reach this string —
    // the visible dot (scorebug.tsx's HalfContent) still marks it visually,
    // but no English (or any-language) fallback word is synthesised here.
    expect(whoNames([{ name: "Alice", serving: true }])).toBe("Alice");
  });

  it("renders the bare name when not serving, even if servingLabel is (oddly) present", () => {
    expect(whoNames([{ name: "Alice", servingLabel: "Serving" }])).toBe("Alice");
  });

  it("joins multiple who-lines with a comma, independent per entry", () => {
    expect(
      whoNames([
        { name: "Alice", serving: true, servingLabel: "Serving" },
        { name: "Bob" },
      ]),
    ).toBe("Alice, Serving, Bob");
  });
});
