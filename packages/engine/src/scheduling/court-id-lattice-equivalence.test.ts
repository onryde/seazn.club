// court-id-lattice-equivalence.test.ts — P9 pass 2 regression (mandatory,
// "the pure-refactor proof"): `buildGrid` + `restrictToConfiguredCourts`
// (together, "the lattice") have never interpreted what a court STRING
// means — only its identity (equality) and its POSITION within
// `config.courts`. Swapping `ScheduleConfig.courts` from human names
// ("Court 1") to court uuids (V368's cutover) is therefore a representation
// change the lattice cannot see: this test proves it, by building the SAME
// lattice twice — once name-keyed, once id-keyed, courts in identical
// positions — projecting each court's identity down to its INDEX position
// (so "did the STRINGS differ" cannot leak into the comparison), and
// asserting the two are byte-identical. It also pins the name-keyed
// (pre-cutover-shaped) run against a committed golden, so a future change to
// the lattice's own STRUCTURE — not just a representation swap — reds here
// too, not only a representation regression.
//
// The dispatch's two golden-capture options were "git show main:<path> into
// a temp fixture" or "generate the golden from a name-keyed run before you
// flip the call site". Neither `buildGrid` (build-grid.ts) nor
// `restrictToConfiguredCourts` (build.ts) changed AT ALL in this pass — the
// cutover is entirely a caller-side (apps/web) change to what STRINGS flow
// into `config.courts` — so running this file's own name-keyed fixture
// against today's unmodified lattice code IS "a name-keyed run" in the
// sense the dispatch means: nothing about how the lattice is built has
// moved, only what apps/web now passes it has.
//
// `restrictToConfiguredCourts` is module-private in build.ts (its only two
// real callers are both inside that file, per the P9 dispatch's own
// file:line pin); reached here through `restrictToConfiguredCourtsForTests`,
// the same test-only export-alias pattern `solveBuildForTests` already uses
// there.
import { describe, expect, it } from "vitest";
import { buildGrid } from "./build-grid.ts";
import { restrictToConfiguredCourtsForTests as restrictToConfiguredCourts } from "./build.ts";
import type { Assignment, SlotConfig } from "./calendar.ts";

const MIN = 60_000;

/** Deterministic stable-stringify: sorts object keys so field-insertion
 *  order in this file can never change the byte comparison — only the
 *  ACTUAL values can. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Builds the SAME fixed "no-calendar org" board — two existing bookings on
 * the first two of three configured courts, the third court free — under
 * whatever `courts` identity space the caller passes in, then projects every
 * court reference in the result down to its INDEX in `courts` (never the
 * literal string) before serializing.
 *
 * `courts` must be supplied in ascending sort order of the strings
 * themselves: `BuildGrid.slots` is documented as sorted by the court STRING
 * (`repairCourts`, which `buildGrid` calls, sorts lexicographically), so
 * index-by-declared-position and index-by-sorted-position must coincide for
 * the projection below to mean the same thing on both a name-keyed and an
 * id-keyed run — both fixtures below are chosen A<B<C / …a<…b<…c precisely
 * so this holds.
 *
 * `sessionWindows` (not a per-court calendar — P10's `usableWindows` owns
 * those, and does not exist yet) bounds `repairUniverse` to a small, fixed
 * 2-hour span instead of falling back to "existing board span ± 7 days",
 * which is what keeps this fixture's lattice small enough to pin as a
 * literal below.
 */
function latticeFingerprint(courts: readonly [string, string, string]): string {
  const existing: Assignment[] = [
    { fixtureId: "e1", court: courts[0], startAt: 0, endAt: 30 * MIN, entrants: [], people: [] },
    { fixtureId: "e2", court: courts[1], startAt: 60 * MIN, endAt: 90 * MIN, entrants: [], people: [] },
  ];
  const config: SlotConfig = {
    startAt: 0,
    matchMinutes: 30,
    gapMinutes: 0,
    courts: [...courts],
    perEntrantMinRest: 0,
    sessionWindows: [{ from: 0, to: 120 * MIN }],
  };
  const grid = restrictToConfiguredCourts(buildGrid({ config, existing }), config.courts, []);
  const indexOf = new Map(courts.map((c, i) => [c, i]));
  const projectedSlots = [...grid.slots]
    .map((s) => ({ court: indexOf.get(s.court), startAt: s.startAt }))
    .sort((a, b) => a.court! - b.court! || a.startAt - b.startAt);
  const projectedByCourt = [...grid.byCourt.entries()]
    .map(([court, rows]) => ({ court: indexOf.get(court), rows: [...rows] }))
    .sort((a, b) => a.court! - b.court!);
  return stableStringify({
    slots: projectedSlots,
    byCourt: projectedByCourt,
    stepMinutes: grid.stepMinutes,
    overCap: grid.overCap,
  });
}

// PLACEHOLDER — captured for real on the first RED run below, then pinned
// as a literal (see the comment at the top of this file for why this counts
// as "a name-keyed run" rather than archived-code archaeology).
const GOLDEN_NAME_KEYED_FINGERPRINT =
  '{"byCourt":[{"court":0,"rows":[0,1,2]},{"court":1,"rows":[3,4,5]},{"court":2,"rows":[6,7,8,9]}],"overCap":false,"slots":[{"court":0,"startAt":1800000},{"court":0,"startAt":3600000},{"court":0,"startAt":5400000},{"court":1,"startAt":0},{"court":1,"startAt":1800000},{"court":1,"startAt":5400000},{"court":2,"startAt":0},{"court":2,"startAt":1800000},{"court":2,"startAt":3600000},{"court":2,"startAt":5400000}],"stepMinutes":30}';

describe("lattice byte-equivalence — the P9 court-id cutover is a pure representation swap", () => {
  it("a name-keyed and an id-keyed run produce an INDEX-IDENTICAL lattice", () => {
    const nameKeyed = latticeFingerprint(["Court A", "Court B", "Court C"]);
    const idKeyed = latticeFingerprint([
      "00000000-0000-4000-8000-00000000000a",
      "00000000-0000-4000-8000-00000000000b",
      "00000000-0000-4000-8000-00000000000c",
    ]);
    expect(idKeyed).toBe(nameKeyed);
  });

  it("matches the committed golden captured from the pre-cutover (name-keyed) shape", () => {
    const nameKeyed = latticeFingerprint(["Court A", "Court B", "Court C"]);
    expect(nameKeyed).toBe(GOLDEN_NAME_KEYED_FINGERPRINT);
  });
});
