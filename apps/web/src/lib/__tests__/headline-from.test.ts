// Fix round 3 (/me orientation) — a stored headline reads HOME first. /me names the player's side first, so a row where
// the player was away must read the score from her side too ("Pat vs Ravens 0 — 2" was a walkover Pat won).
//
// The expected value is never typed here and never taken from `headlineFrom`: the away player's view of a ledger is the
// HOME headline the engine itself prints for the MIRRORED ledger (the same result with the sides swapped). Swept over
// every registry sport for a walkover (each sport's own credit), and for a played result where a sport's events name
// their sides plainly (badminton's game summaries, generic's result), which also covers the set-score detail.
import { describe, expect, it } from "vitest";
import { foldMatch, type EventEnvelope } from "@seazn/engine/core";
import { builtinModules } from "@seazn/engine/sports";
import { defaultLineupPair, makeEnvelope } from "@seazn/engine/testkit";
import { headlineFrom } from "@/lib/headline-from";

type Mod = (typeof builtinModules)[number];
const cfgOf = (m: Mod, variant?: string) =>
  m.configSchema.parse((variant ? (m.variants as Record<string, unknown>)[variant] : Object.values(m.variants)[0]) ?? {});
const headlineOf = (m: Mod, events: EventEnvelope[], variant?: string) => {
  const lu = defaultLineupPair(m.positions);
  return (m.summary(foldMatch(m, cfgOf(m, variant) as never, lu, events) as never) as { headline: string }).headline;
};
const ids = (m: Mod) => {
  const lu = defaultLineupPair(m.positions) as unknown as { home: { entrantId: string }; away: { entrantId: string } };
  return { home: lu.home.entrantId, away: lu.away.entrantId };
};
const walkover = (by: string) => [makeEnvelope(1, { type: "core.forfeit", payload: { by, reason: "walkover" } })];

describe("headlineFrom — the stored home-first headline, read from one side", () => {
  it("every registry sport's walkover: the away view is the mirrored result's home headline; the home view is unchanged", () => {
    let checked = 0;
    for (const m of builtinModules) {
      const { home, away } = ids(m);
      const awayForfeits = headlineOf(m, walkover(away)); // home is credited
      const homeForfeits = headlineOf(m, walkover(home)); // the mirror: away is credited
      expect(headlineFrom(awayForfeits, "home"), `${m.key}: the home view is the stored headline`).toBe(awayForfeits);
      expect(headlineFrom(awayForfeits, "away"), `${m.key}: the away view of "${awayForfeits}"`).toBe(homeForfeits);
      expect(headlineFrom(homeForfeits, "away"), `${m.key}: and back`).toBe(awayForfeits);
      checked++;
    }
    console.info(`headline-from: ${checked} sports swept`);
    expect(checked, "the registry was swept").toBe(builtinModules.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("a played result whose events name their sides: badminton's games (with the set detail) and generic's result", () => {
    const badminton = builtinModules.find((m) => m.key === "badminton")!;
    const generic = builtinModules.find((m) => m.key === "generic")!;
    const games = (pairs: [number, number][]) => [
      makeEnvelope(1, { type: "core.start", payload: {} }),
      ...pairs.map(([h, a], i) => makeEnvelope(i + 2, { type: "badminton.game.summary", payload: { home: h, away: a } })),
    ];
    // generic's `score` variant: its result names both scores (the default win_loss names only a winner).
    const played: [Mod, EventEnvelope[], EventEnvelope[], string?][] = [
      [badminton, games([[21, 10], [18, 21], [21, 17]]), games([[10, 21], [21, 18], [17, 21]])],
      [
        generic,
        [makeEnvelope(1, { type: "core.start", payload: {} }), makeEnvelope(2, { type: "generic.result", payload: { p1Score: 3, p2Score: 1 } })],
        [makeEnvelope(1, { type: "core.start", payload: {} }), makeEnvelope(2, { type: "generic.result", payload: { p1Score: 1, p2Score: 3 } })],
        "score",
      ],
    ];
    let checked = 0;
    for (const [m, ledger, mirror, variant] of played) {
      const stored = headlineOf(m, ledger, variant);
      const fromAway = headlineOf(m, mirror, variant);
      console.info(`headline-from: ${m.key} played "${stored}" / mirrored "${fromAway}"`);
      expect(stored, `${m.key}: premise — the two orientations differ`).not.toBe(fromAway);
      if (m.key === "badminton") expect(stored, "premise: the set-score detail is in play").toMatch(/ · \d+–\d+/);
      expect(headlineFrom(stored, "away"), `${m.key}: the away view of "${stored}"`).toBe(fromAway);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("tennis's tiebreak notation turns with the set: 7–6(3) from the other side is 6–7(3) (the loser's points stay in brackets)", () => {
    expect(headlineFrom("2 — 1 · 6–3 6–7(3) 7–6(5)", "away")).toBe("1 — 2 · 3–6 7–6(3) 6–7(5)");
  });

  it("a headline that is not '<home> — <away>' is refused (null), never guessed — the caller keeps the stored order", () => {
    let checked = 0;
    for (const odd of ["vs", "", "1 — 2 — 3", "Abandoned"]) {
      expect(headlineFrom(odd, "away"), JSON.stringify(odd)).toBeNull();
      expect(headlineFrom(odd, "home"), `${JSON.stringify(odd)} from home: unchanged`).toBe(odd);
      checked++;
    }
    expect(checked).toBe(4);
  });
});
