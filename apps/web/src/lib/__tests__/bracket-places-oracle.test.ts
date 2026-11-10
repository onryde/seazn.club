// W4 app B, Task 14 (brief Step 2b): the app's bracketPlaceLabels against the bracket-progression ORACLE (@seazn/reference,
// from rulebook-W4-knockout.md). The oracle says who holds which place; the labels must carry that rank, and call a place
// SHARED exactly where the rulebook declares one (RB4-T2 two 3rds, RB4-T6 two 4ths, RB4-C3 two 2nds, RB4-C4 two 1sts).
// Lives here, not in tools/matrix: this file needs the app's `@/` alias. The oracle is imported by relative path - it is a
// pure, engine-free package (apps/web does not depend on @seazn/reference).
// single-sport: none - the labels read ranks only, no sport field.
import { describe, expect, it } from "vitest";
import { bracketPlaceLabels } from "@/lib/bracket-places";
import { bracketProgression, type RankInput } from "../../../../../packages/reference/src/index.ts";

describe("bracketPlaceLabels vs the oracle's places (RB4-T2, T6, C3, C4)", () => {
  it("over title x third-place x semi-final shape: the rank is the oracle's, and `shared` is the rulebook's (counted)", () => {
    let checked = 0;
    let sharedRows = 0;
    const titles: RankInput["title"][] = [
      { kind: "champion", champion: "A", runnerUp: "B" },
      { kind: "joint", winners: ["A", "B"] },
      { kind: "vacant", finalists: ["A", "B"] },
    ];
    const thirds: Pick<RankInput, "thirdPlace" | "semiLosers" | "playoff">[] = [
      { thirdPlace: "shared", semiLosers: [] }, // n = 2
      { thirdPlace: "shared", semiLosers: ["C"] }, // n = 3: one semi is a bye
      { thirdPlace: "shared", semiLosers: ["C", "D"] }, // RB4-T2
      { thirdPlace: "playoff", semiLosers: ["C", "D"], playoff: { kind: "decided", winner: "C", loser: "D" } },
      { thirdPlace: "playoff", semiLosers: ["C", "D"], playoff: { kind: "walkover", winner: "D", loser: "C" } },
      { thirdPlace: "playoff", semiLosers: ["C", "D"], playoff: { kind: "both_out" } }, // RB4-T6
    ];
    for (const title of titles) {
      for (const third of thirds) {
        const others = [{ entrant: "E", eliminatedRound: 0, seed: 5 }, { entrant: "F", eliminatedRound: 0, seed: 6 }];
        const places = bracketProgression.ranks({ title, others, ...third });
        const labels = bracketPlaceLabels(places.map((p) => ({ entrantId: p.entrant, rank: p.rank })));
        // the rulebook's shared places, from the stage's shape - not from the ranks under test
        const sharedEntrants = new Set<string>([
          ...(title.kind === "joint" ? title.winners : title.kind === "vacant" ? title.finalists : []),
          ...(third.semiLosers.length === 2 && (third.thirdPlace === "shared" || third.playoff?.kind === "both_out") ? third.semiLosers : []),
        ]);
        const tag = `${title.kind} / ${third.thirdPlace} / ${third.semiLosers.length} semis / ${third.playoff?.kind ?? "-"}`;
        expect(labels.size, tag).toBe(places.length);
        for (const p of places) {
          expect(labels.get(p.entrant)?.rank, `${tag} ${p.entrant}`).toBe(p.rank);
          expect(labels.get(p.entrant)?.shared, `${tag} ${p.entrant} shared`).toBe(sharedEntrants.has(p.entrant));
          checked++;
          if (sharedEntrants.has(p.entrant)) sharedRows++;
        }
      }
    }
    expect(checked).toBe(3 * (4 + 5 + 6 + 6 + 6 + 6)); // rows examined: title x (finalists + semi losers + two others) per shape
    expect(sharedRows).toBeGreaterThan(0);
  });
});
