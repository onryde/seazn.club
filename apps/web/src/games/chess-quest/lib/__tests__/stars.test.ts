import { describe, expect, it } from "vitest";
import { STAR_RULES } from "../stars";

describe("star formulas (ported thresholds)", () => {
  it("squareRace", () => {
    expect(STAR_RULES.squareRace(12)).toBe(3);
    expect(STAR_RULES.squareRace(11)).toBe(2);
    expect(STAR_RULES.squareRace(7)).toBe(2);
    expect(STAR_RULES.squareRace(6)).toBe(1);
    expect(STAR_RULES.squareRace(3)).toBe(1);
    expect(STAR_RULES.squareRace(2)).toBe(0);
  });
  it("coinHop — easy sliders vs hard steppers", () => {
    expect(STAR_RULES.coinHop(9, "Q")).toBe(3);
    expect(STAR_RULES.coinHop(10, "Q")).toBe(2);
    expect(STAR_RULES.coinHop(13, "R")).toBe(2);
    expect(STAR_RULES.coinHop(14, "B")).toBe(1);
    expect(STAR_RULES.coinHop(14, "N")).toBe(3);
    expect(STAR_RULES.coinHop(15, "N")).toBe(2);
    expect(STAR_RULES.coinHop(20, "K")).toBe(2);
    expect(STAR_RULES.coinHop(21, "P")).toBe(1);
  });
  it("pawnWars", () => {
    expect(STAR_RULES.pawnWars(true)).toBe(3);
    expect(STAR_RULES.pawnWars(false)).toBe(1);
  });
  it("rookMaze vs par", () => {
    expect(STAR_RULES.rookMaze(5, 5)).toBe(3);
    expect(STAR_RULES.rookMaze(6, 5)).toBe(2);
    expect(STAR_RULES.rookMaze(7, 5)).toBe(1);
  });
  it("openingTrainer by mistakes", () => {
    expect(STAR_RULES.openingTrainer(0)).toBe(3);
    expect(STAR_RULES.openingTrainer(1)).toBe(2);
    expect(STAR_RULES.openingTrainer(2)).toBe(2);
    expect(STAR_RULES.openingTrainer(3)).toBe(1);
  });
});

// packStars is scaled to the pack: 1 star at a third, 2 at two thirds, 3 at
// all. The legacy fixed thresholds are this formula at their original sizes,
// pinned here so a regression to fixed numbers reds on the old packs too.
describe("packStars scales to the pack size", () => {
  it("reproduces the legacy 12-pack thresholds (12 / 8 / 4)", () => {
    expect(STAR_RULES.packStars(12, 12)).toBe(3);
    expect(STAR_RULES.packStars(11, 12)).toBe(2);
    expect(STAR_RULES.packStars(8, 12)).toBe(2);
    expect(STAR_RULES.packStars(7, 12)).toBe(1);
    expect(STAR_RULES.packStars(4, 12)).toBe(1);
    expect(STAR_RULES.packStars(3, 12)).toBe(0);
  });
  it("reproduces the legacy mate-in-3 thresholds (9 / 6 / 3)", () => {
    expect(STAR_RULES.packStars(9, 9)).toBe(3);
    expect(STAR_RULES.packStars(8, 9)).toBe(2);
    expect(STAR_RULES.packStars(6, 9)).toBe(2);
    expect(STAR_RULES.packStars(5, 9)).toBe(1);
    expect(STAR_RULES.packStars(3, 9)).toBe(1);
    expect(STAR_RULES.packStars(2, 9)).toBe(0);
  });
  it("a five-puzzle lesson slice can earn every star (the fixed rule gave it none)", () => {
    expect(STAR_RULES.packStars(5, 5)).toBe(3);
    expect(STAR_RULES.packStars(4, 5)).toBe(2);
    expect(STAR_RULES.packStars(3, 5)).toBe(1);
    expect(STAR_RULES.packStars(2, 5)).toBe(1);
    expect(STAR_RULES.packStars(1, 5)).toBe(0);
    expect(STAR_RULES.packStars(0, 5)).toBe(0);
  });
  it("rounds the thirds UP, so a partial third never counts (8-pack: 8 / 6 / 3)", () => {
    expect(STAR_RULES.packStars(8, 8)).toBe(3);
    expect(STAR_RULES.packStars(7, 8)).toBe(2);
    expect(STAR_RULES.packStars(6, 8)).toBe(2);
    expect(STAR_RULES.packStars(5, 8)).toBe(1);
    expect(STAR_RULES.packStars(3, 8)).toBe(1);
    expect(STAR_RULES.packStars(2, 8)).toBe(0);
  });
  it("three stars need the WHOLE pack, whatever its size", () => {
    for (const total of [3, 4, 6, 8, 16, 24, 35]) {
      expect(STAR_RULES.packStars(total, total), `total ${total}`).toBe(3);
      expect(STAR_RULES.packStars(total - 1, total), `total ${total}`).toBeLessThan(3);
    }
  });
  it("an empty pack scores nothing", () => {
    expect(STAR_RULES.packStars(0, 0)).toBe(0);
    expect(STAR_RULES.packStars(3, 0)).toBe(0);
  });
});
