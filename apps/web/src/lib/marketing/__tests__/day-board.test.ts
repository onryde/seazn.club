// The Scheduling page's demo model: a small day board that refuses the clashes the real board refuses.
import { describe, expect, it } from "vitest";
import { COURTS, MATCHES, SLOTS, SLOT_MINUTES, MAX_DELAY, clockAt, delay, fillRest, isComplete, openingDay, pick, placeAt, publicRows, publish, type DayState } from "../day-board";

const cellsOf = (s: DayState) => Object.values(s.placed).map((c) => `${c.court}:${c.slot}`);
/** Independent check of the two rules, from the rulebook and not from the model: one match per court per time, and
 *  nobody in two matches at once. Returns how many pairs it compared, so a caller can prove it compared some. */
function assertClashFree(s: DayState): number {
  const placed = MATCHES.filter((m) => s.placed[m.id]);
  let pairs = 0;
  for (let i = 0; i < placed.length; i++)
    for (let j = i + 1; j < placed.length; j++) {
      const [a, b] = [placed[i]!, placed[j]!];
      const [ca, cb] = [s.placed[a.id]!, s.placed[b.id]!];
      pairs++;
      if (ca.slot !== cb.slot) continue;
      expect(ca.court, `${a.id} and ${b.id} share a court and a time`).not.toBe(cb.court);
      expect([a.home, a.away].some((t) => t === b.home || t === b.away), `${a.id} and ${b.id} share a team at one time`).toBe(false);
    }
  return pairs;
}

describe("day board", () => {
  it("has exactly as many matches as cells, so a full board is possible and tight", () => {
    expect(MATCHES).toHaveLength(COURTS * SLOTS);
    // Every pair of the four teams meets once: n(n-1)/2.
    const teams = new Set(MATCHES.flatMap((m) => [m.home, m.away]));
    expect(MATCHES).toHaveLength((teams.size * (teams.size - 1)) / 2);
  });

  it("opens part-filled, clash-free, unpublished, with matches left for the visitor", () => {
    const s = openingDay();
    const placed = Object.keys(s.placed).length;
    expect(placed).toBeGreaterThan(0);
    expect(placed).toBeLessThan(MATCHES.length);
    expect(assertClashFree(s)).toBeGreaterThan(0);
    expect(s.published).toBe(false);
    expect(isComplete(s)).toBe(false);
  });

  it("places a picked match in a free cell", () => {
    const s0 = openingDay();
    const free = MATCHES.find((m) => !s0.placed[m.id])!;
    const s1 = fillRest(s0);
    const target = s1.placed[free.id]!; // a cell the solver proved legal for it
    const s = placeAt(pick(s0, free.id), target);
    expect(s.placed[free.id]).toEqual(target);
    expect(s.refused).toBeNull();
    expect(s.picked).toBeNull();
  });

  it("refuses a second match on a taken court and says which rule", () => {
    const s0 = openingDay();
    const free = MATCHES.find((m) => !s0.placed[m.id])!;
    const taken = Object.values(s0.placed)[0]!;
    const s = placeAt(pick(s0, free.id), taken);
    expect(s.placed[free.id]).toBeUndefined();
    expect(s.refused).toEqual({ kind: "court", matchId: free.id });
    expect(cellsOf(s)).toEqual(cellsOf(s0));
  });

  it("refuses a team playing two matches at once and names the team", () => {
    // Build the case from the data: a placed match, a free cell at the same time, an unplaced match sharing a team.
    const s0 = openingDay();
    let reached = 0;
    for (const placedMatch of MATCHES.filter((m) => s0.placed[m.id])) {
      const at = s0.placed[placedMatch.id]!;
      const freeCourt = Array.from({ length: COURTS }, (_, c) => c).find((c) => !Object.values(s0.placed).some((p) => p.slot === at.slot && p.court === c));
      const rival = MATCHES.find((m) => !s0.placed[m.id] && [m.home, m.away].some((t) => t === placedMatch.home || t === placedMatch.away));
      if (freeCourt === undefined || !rival) continue;
      reached++;
      const s = placeAt(pick(s0, rival.id), { court: freeCourt, slot: at.slot });
      expect(s.placed[rival.id]).toBeUndefined();
      expect(s.refused?.kind).toBe("team");
      expect([placedMatch.home, placedMatch.away]).toContain(s.refused?.kind === "team" ? s.refused.team : -1);
    }
    expect(reached, "the opening day must leave a team-clash to try, or the demo cannot show the refusal").toBeGreaterThan(0);
  });

  it("picking a placed match lifts it off the board; placing with nothing picked changes nothing", () => {
    const s0 = openingDay();
    const id = Object.keys(s0.placed)[0]!;
    const lifted = pick(s0, id);
    expect(lifted.placed[id]).toBeUndefined();
    expect(lifted.picked).toBe(id);
    expect(placeAt(s0, { court: 0, slot: 0 })).toEqual(s0);
  });

  it("fill-the-rest completes the board clash-free from the opening day and from every one-move state", () => {
    const start = openingDay();
    const done = fillRest(start);
    expect(isComplete(done)).toBe(true);
    expect(assertClashFree(done)).toBe((MATCHES.length * (MATCHES.length - 1)) / 2);
    // What the visitor already placed is kept when the board can still be completed around it.
    for (const [id, cell] of Object.entries(start.placed)) expect(done.placed[id]).toEqual(cell);
    let states = 0;
    for (const m of MATCHES.filter((x) => !start.placed[x.id]))
      for (let court = 0; court < COURTS; court++)
        for (let slot = 0; slot < SLOTS; slot++) {
          const s = placeAt(pick(start, m.id), { court, slot });
          const full = fillRest(s);
          states++;
          expect(isComplete(full), `${m.id} at ${court}:${slot}`).toBe(true);
          assertClashFree(full);
        }
    expect(states).toBe((MATCHES.length - Object.keys(start.placed).length) * COURTS * SLOTS);
    // And from an empty board, and a second call is a no-op.
    expect(isComplete(fillRest({ ...start, placed: {} }))).toBe(true);
    expect(fillRest(done)).toEqual(done);
  });

  it("publishes only a complete board; the public list is every match in time order", () => {
    expect(publish(openingDay()).published).toBe(false);
    expect(publicRows(openingDay())).toEqual([]);
    const s = publish(fillRest(openingDay()));
    expect(s.published).toBe(true);
    const rows = publicRows(s);
    expect(rows).toHaveLength(MATCHES.length);
    expect(rows.map((r) => r.time)).toEqual([...rows.map((r) => r.time)].sort());
    expect(rows[0]!.time).toBe(clockAt(0, 0));
    expect(new Set(rows.map((r) => r.matchId)).size).toBe(MATCHES.length);
  });

  it("a delay moves every published time by the same minutes, and stops at its limit", () => {
    const s0 = publish(fillRest(openingDay()));
    const s1 = delay(s0);
    expect(s1.delayMinutes).toBeGreaterThan(0);
    const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
    const before = publicRows(s0), after = publicRows(s1);
    expect(after).toHaveLength(before.length);
    for (let i = 0; i < before.length; i++) expect(mins(after[i]!.time) - mins(before[i]!.time)).toBe(s1.delayMinutes);
    expect(s1.published).toBe(true);
    let s = s1;
    for (let i = 0; i < 20; i++) s = delay(s);
    expect(s.delayMinutes).toBe(MAX_DELAY);
    expect(mins(clockAt(1, 0)) - mins(clockAt(0, 0))).toBe(SLOT_MINUTES);
  });

  it("moving a match after publishing takes the board back to draft", () => {
    const s = publish(fillRest(openingDay()));
    const id = Object.keys(s.placed)[0]!;
    expect(pick(s, id).published).toBe(false);
  });
});
