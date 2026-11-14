// The /start "Sent stepper" (owner-approved 2026-11-14, mock sss14a Option A + section 4): the five steps an organiser walks
// from the Sent screen to a scheduled event, and which one is theirs now. Expected values are the RULE, written here in the
// owner's words, never read back off the module:
//
//   1 Open the link in your email — done on the landing (the page exists only once the link was opened and claimed).
//   2 Rename your organisation — done once the organisation no longer carries the claim's starter name (`orgRenamed`).
//   3 Add your players — done once the field reaches the size chosen on /start, or once fixtures exist (Generate fixed the
//     field: a smaller field the organiser chose to run is still their field).
//   4 Generate fixtures — done once any fixture exists.
//   5 Schedule matches — done once any fixture has a time.
//   The current step is the FIRST step not done; the rest not done wait.
//   The landing stepper shows only for a competition a /start draft built (a target), and hides once a match is
//   scheduled (step 5 done: there is no step left to lead to).
//
// Sent: nothing has happened yet, so step 1 is current and every other step waits.
import { describe, expect, it } from "vitest";
import {
  GETTING_STARTED_STEPS,
  landingSteps,
  scheduleHint,
  sentSteps,
  type GettingStartedProgress,
} from "../getting-started-steps";

const EMPTY: GettingStartedProgress = {
  orgRenamed: false,
  entrants: { count: 0, target: 8 },
  fixturesGenerated: false,
  fixtureScheduled: false,
};
const at = (patch: Partial<Omit<GettingStartedProgress, "entrants">> & { count?: number; target?: number | null } = {}) => {
  const { count = EMPTY.entrants.count, target = EMPTY.entrants.target, ...rest } = patch;
  return { ...EMPTY, ...rest, entrants: { count, target } };
};
/** The states, in step order, as one string: d = done, C = current, . = waiting. */
const shape = (p: GettingStartedProgress): string | null => {
  const r = landingSteps(p);
  return r === null ? null : r.steps.map((s) => (s.state === "done" ? "d" : s.state === "current" ? "C" : ".")).join("");
};

describe("the five steps, in the owner's order", () => {
  it("open, rename, players, generate, schedule", () => {
    expect(GETTING_STARTED_STEPS).toEqual(["open", "rename", "players", "generate", "schedule"]);
  });
});

describe("Sent: step 1 is current, every other step waits", () => {
  it("one current, four waiting, none done", () => {
    expect(sentSteps()).toEqual([
      { key: "open", state: "current" },
      { key: "rename", state: "todo" },
      { key: "players", state: "todo" },
      { key: "generate", state: "todo" },
      { key: "schedule", state: "todo" },
    ]);
  });
});

describe("the landing: named cases", () => {
  // Each case's shape is written from the rule above; the case where the right answer differs from a plausible wrong one
  // is named in its title.
  const CASES: readonly [string, GettingStartedProgress, string | null, number | null][] = [
    // The empty case first: nothing done but opening the link.
    ["just claimed: step 1 ticked, rename is current", EMPTY, "dC...", 1],
    ["renamed, no players yet: players is current", at({ orgRenamed: true }), "ddC..", 2],
    ["renamed, field one short of the target: players stays current", at({ orgRenamed: true, count: 7 }), "ddC..", 2],
    ["renamed, field at the target: generate is current", at({ orgRenamed: true, count: 8 }), "dddC.", 3],
    ["renamed, field past the target (added more): generate is current", at({ orgRenamed: true, count: 9 }), "dddC.", 3],
    // Players done without renaming: rename is still the first not done, so it is current — the players tick stays.
    ["field full but never renamed: rename is current, players ticked", at({ count: 8 }), "dCd..", 2],
    // A field short of the target that was generated anyway: Generate fixed the field, so players is done too.
    ["generated on a short field: players counts as done, schedule is current", at({ orgRenamed: true, count: 6, fixturesGenerated: true }), "ddddC", 4],
    ["generated, never renamed: rename is current, the rest up to schedule ticked", at({ count: 8, fixturesGenerated: true }), "dCdd.", 3],
    // A withdrawal after the field was full takes the tick back (before Generate).
    ["a withdrawal drops the field below the target before Generate: players is current again", at({ orgRenamed: true, count: 7 }), "ddC..", 2],
    // Hidden.
    ["a match is scheduled: the stepper hides", at({ orgRenamed: true, count: 8, fixturesGenerated: true, fixtureScheduled: true }), null, null],
    ["scheduled though never renamed: still hidden (step 5 done ends the path)", at({ fixturesGenerated: true, fixtureScheduled: true }), null, null],
    ["no /start draft built this competition (no target): hidden", at({ target: null }), null, null],
    ["no target even with nothing done and players added: hidden", at({ target: null, count: 3, orgRenamed: true }), null, null],
  ];

  for (const [title, progress, want, done] of CASES) {
    it(title, () => {
      expect(shape(progress)).toBe(want);
      expect(landingSteps(progress)?.done ?? null).toBe(done);
    });
  }
});

describe("the landing: every combination", () => {
  it("visible exactly when there is a target and nothing is scheduled; then one current step, the first not done", () => {
    let checked = 0;
    let visible = 0;
    for (const orgRenamed of [false, true])
      for (const target of [null, 2, 8])
        for (const count of [0, 1, 2, 7, 8, 9])
          for (const fixturesGenerated of [false, true])
            for (const fixtureScheduled of [false, true]) {
              const p: GettingStartedProgress = { orgRenamed, entrants: { count, target }, fixturesGenerated, fixtureScheduled };
              const r = landingSteps(p);
              const label = JSON.stringify(p);
              checked++;
              if (target === null || fixtureScheduled) {
                expect(r, `${label}: hidden`).toBeNull();
                continue;
              }
              visible++;
              expect(r, `${label}: shown`).not.toBeNull();
              const steps = r!.steps;
              expect(steps.map((s) => s.key), label).toEqual([...GETTING_STARTED_STEPS]);
              // Each step's tick, from the rule.
              const done: Record<string, boolean> = {
                open: true,
                rename: orgRenamed,
                players: fixturesGenerated || count >= target,
                generate: fixturesGenerated,
                schedule: false,
              };
              for (const s of steps) expect(s.state === "done", `${label}: ${s.key} done`).toBe(done[s.key]);
              const current = steps.filter((s) => s.state === "current");
              expect(current, `${label}: one current step`).toHaveLength(1);
              const firstNotDone = GETTING_STARTED_STEPS.find((k) => !done[k]);
              expect(current[0]!.key, `${label}: the first step not done`).toBe(firstNotDone);
              expect(r!.done, `${label}: the count of ticks`).toBe(Object.values(done).filter(Boolean).length);
            }
    // Anti-vacuity: the sweep saw every combination and both outcomes.
    expect(checked).toBe(2 * 3 * 6 * 2 * 2);
    expect(visible).toBeGreaterThan(0);
    expect(visible).toBeLessThan(checked);
  });
});

describe("step 5's hint: courts and a first day only where the organiser gave them", () => {
  it("names the courts when Planning was opened, the first day when one was picked, neither when neither", () => {
    const CASES = [
      [{ courts: 2, date: "2026-11-21" }, { key: "start.next.schedule.courtsDate", vars: { courts: 2, date: "2026-11-21" } }],
      [{ courts: 2, date: null }, { key: "start.next.schedule.courts", vars: { courts: 2 } }],
      [{ courts: null, date: "2026-11-21" }, { key: "start.next.schedule.date", vars: { date: "2026-11-21" } }],
      [{ courts: null, date: null }, { key: "start.next.schedule.plain", vars: {} }],
      // No court at all (a venue whose courts were all archived) reads as no courts, not "0 courts".
      [{ courts: 0, date: null }, { key: "start.next.schedule.plain", vars: {} }],
    ] as const;
    let checked = 0;
    for (const [input, want] of CASES) {
      expect(scheduleHint(input.courts, input.date), JSON.stringify(input)).toEqual(want);
      checked++;
    }
    expect(checked).toBe(5);
  });
});
