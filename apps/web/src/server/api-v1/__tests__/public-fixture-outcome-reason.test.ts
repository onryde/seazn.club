// Loop R M-14 — `GET /public/fixtures/{id}` serves the stored outcome, and since W2b (D1, D2) an award carries WHY:
// `reason`, from the engine's closed vocabulary (`AWARD_REASONS`: the four forfeit reasons and the system's bye). The
// response schema declared `kind`/`winner`/`loser`/`method` only, so a consumer that parses against it lost the reason
// (zod strips an undeclared key) and the published OpenAPI document never named it. The enum is the engine's own list,
// never a copy typed here.
import { describe, expect, it } from "vitest";
import { AWARD_REASONS, MatchOutcome } from "@seazn/engine/core";
import { PublicFixtureOutcome } from "@/server/api-v1/schemas";
import { buildOpenApiDocument } from "@/server/api-v1/openapi";

/** An award the ENGINE accepts for this reason (a bye names no loser; every forfeit names one). */
const award = (reason: (typeof AWARD_REASONS)[number]) =>
  MatchOutcome.parse({ kind: "award", winner: "e-home", loser: reason === "bye" ? null : "e-away", reason });

describe("PublicFixtureOutcome declares the award's reason (Loop R M-14)", () => {
  it("empty case first: a fixture with no outcome parses to null, and a played win carries no reason", () => {
    expect(PublicFixtureOutcome.parse(null)).toBeNull();
    const win = PublicFixtureOutcome.parse({ kind: "win", winner: "e-home", loser: "e-away", method: "regulation" });
    expect(win).toEqual({ kind: "win", winner: "e-home", loser: "e-away", method: "regulation" });
    expect(win && "reason" in win).toBe(false);
  });

  it("every reason the engine can store survives the parse — counted over AWARD_REASONS", () => {
    let checked = 0;
    for (const reason of AWARD_REASONS) {
      const stored = award(reason);
      expect(PublicFixtureOutcome.parse(stored), reason).toMatchObject({ kind: "award", winner: "e-home", reason });
      checked++;
    }
    expect(checked).toBe(AWARD_REASONS.length);
    expect(checked, "the vocabulary is not empty").toBeGreaterThan(0);
  });

  it("a reason outside the vocabulary is refused, not passed through as free text", () => {
    expect(PublicFixtureOutcome.safeParse({ kind: "award", winner: "e-home", loser: "e-away", reason: "rain" }).success).toBe(false);
  });

  it("the OpenAPI document publishes the field with exactly the engine's enum, in its order", () => {
    for (const published of [false, true]) {
      const doc = JSON.stringify(buildOpenApiDocument({ published }));
      // The public fixture response's outcome: the one object schema that pairs `method` with `reason`.
      const enums = [...doc.matchAll(/"reason":\{"type":"string","enum":(\[[^\]]*\])\}/g)].map((m) => JSON.parse(m[1]!) as string[]);
      expect(
        enums.some((e) => JSON.stringify(e) === JSON.stringify([...AWARD_REASONS])),
        `${published ? "published" : "full"} document: a reason enum equal to AWARD_REASONS`,
      ).toBe(true);
    }
  });
});
