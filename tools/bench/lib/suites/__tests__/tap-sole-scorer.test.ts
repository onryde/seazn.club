// A key the pad stamps on a tapped row must already be in the pack (bench run 41208936894, 2026-10-31).
//
// On the TAP route the pad writes a key the pack is allowed to leave out. Generic's half tap stamps the side's SOLE
// on-field player as `person` (generic.tsx `buildHalf`, `soleScorer`), and the adapter's `tolerableExtraKeys` is the
// bench's own declaration of that stamp. On the API route the payload lands as authored, and generic's `scores` and
// `points` metrics credit `payload.person` only: they declare no entrant fallback (`fromEntrant`). So a
// `generic.score` that leaves `person` out on a one-player side credits that player on one route and nobody on the
// other. The pack's expected.leaderboards can then be right on only one of them. _tiny's rr-r3-c1 was that case:
// its point was authored with no person and the live tap run stamped Ana's id. d-tiny's leaderboard read 3 where
// the pack said 2.
//
// The rule: in a division a suite plays by tap, every key the adapter says the pad stamps must already be authored,
// and it must name the side's sole roster member. Then both routes record the same row. The bench seeds each side's
// team sheet from its roster (tap mode, R62), so the sole roster member is the sole on-field player.
//
// The sweep runs over the suite registry, not one pack. Only `_tiny` declares a tap division today.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { adapterForSport } from "../../tap-play.ts";
import { SUITE_REGISTRY } from "../registry.ts";

interface PackEvent {
  readonly type: string;
  readonly payload?: Record<string, unknown>;
}
interface PackShape {
  readonly divisions: readonly { readonly ref: string; readonly sportKey: string }[];
  readonly entrants: readonly {
    readonly ref: string;
    readonly divisionRef: string;
    readonly roster?: readonly { readonly person: string }[];
  }[];
  readonly streams?: readonly {
    readonly divisionRef: string;
    readonly fixtureExtKey: string;
    readonly events: readonly PackEvent[];
  }[];
}

interface SoleScorerSweep {
  /** (event, stamped key) pairs on a one-player side: the pairs the rule binds. */
  readonly checked: number;
  readonly offenders: readonly string[];
}

/** Every pad-stamped key on a one-player side, judged against the side's sole roster member. */
function soleScorerSweep(label: string, pack: PackShape, tapDivisionRefs: readonly string[]): SoleScorerSweep {
  let checked = 0;
  const offenders: string[] = [];
  for (const divisionRef of tapDivisionRefs) {
    const division = pack.divisions.find((d) => d.ref === divisionRef);
    if (division === undefined) {
      offenders.push(`${label}: play names "${divisionRef}", a division the pack does not declare`);
      continue;
    }
    const adapter = adapterForSport(division.sportKey);
    if (adapter === undefined) {
      offenders.push(`${label}/${divisionRef}: no tap adapter for sport "${division.sportKey}"`);
      continue;
    }
    const rosterOf = (entrantRef: string): readonly string[] =>
      pack.entrants.find((e) => e.ref === entrantRef && e.divisionRef === divisionRef)?.roster?.map((m) => m.person) ?? [];
    for (const stream of (pack.streams ?? []).filter((s) => s.divisionRef === divisionRef)) {
      stream.events.forEach((event, index) => {
        const stamped = adapter.tolerableExtraKeys?.(event.type) ?? [];
        if (stamped.length === 0) return;
        const where = `${label}/${divisionRef}/${stream.fixtureExtKey} event ${index} (${event.type})`;
        // generic.tsx `buildHalf` puts the tapped side in `by`. A stamped event with no side would leave nothing to
        // resolve the sole player from, so it is refused, not skipped.
        const by = event.payload?.by;
        if (typeof by !== "string" || !by.startsWith("@")) {
          offenders.push(`${where}: no "@"-ref side in payload.by to resolve the stamped key from`);
          return;
        }
        const roster = rosterOf(by.slice(1));
        // A side with more than one player is asked through the dock, so the pad stamps nothing on it.
        if (roster.length !== 1) return;
        for (const key of stamped) {
          checked += 1;
          const want = `@${roster[0]}`;
          const got = event.payload?.[key];
          if (got !== want) {
            offenders.push(
              `${where}: "${key}" is ${JSON.stringify(got)}, but the pad stamps ${JSON.stringify(want)} ` +
                `(the sole player of ${by}). The API route records the authored payload, so the two routes disagree`,
            );
          }
        }
      });
    }
  }
  return { checked, offenders };
}

function tapPacks(): { label: string; pack: PackShape; tapDivisionRefs: string[] }[] {
  return [...SUITE_REGISTRY.values()].flatMap((def) => {
    const tapDivisionRefs = Object.entries(def.play ?? {})
      .filter(([, mode]) => mode === "tap")
      .map(([ref]) => ref);
    if (tapDivisionRefs.length === 0) return [];
    const pack = JSON.parse(readFileSync(def.packPath, "utf8")) as PackShape;
    return [{ label: def.key, pack, tapDivisionRefs }];
  });
}

describe("tap play: a key the pad stamps is already in the pack, on every one-player side", () => {
  it("every registered tap division authors the sole player the pad would stamp", () => {
    const packs = tapPacks();
    expect(packs.length, "suites in the registry that play a division by tap").toBeGreaterThan(0);
    let checked = 0;
    const offenders: string[] = [];
    for (const { label, pack, tapDivisionRefs } of packs) {
      const sweep = soleScorerSweep(label, pack, tapDivisionRefs);
      checked += sweep.checked;
      offenders.push(...sweep.offenders);
    }
    expect(offenders).toEqual([]);
    // Zero checked would mean the rule bound nothing and passed vacuously.
    expect(checked, `stamped (event, key) pairs checked across ${packs.length} suite(s)`).toBeGreaterThan(0);
  });

  it("reds on every bound pair once the stamped key is stripped from the pack (the rule can fail)", () => {
    for (const { label, pack, tapDivisionRefs } of tapPacks()) {
      const honest = soleScorerSweep(label, pack, tapDivisionRefs);
      if (honest.checked === 0) continue;
      const sportOf = (divisionRef: string) => pack.divisions.find((d) => d.ref === divisionRef)?.sportKey ?? "";
      const stripped: PackShape = {
        ...pack,
        streams: (pack.streams ?? []).map((s) => ({
          ...s,
          events: s.events.map((e) => {
            const stamped = adapterForSport(sportOf(s.divisionRef))?.tolerableExtraKeys?.(e.type) ?? [];
            if (e.payload === undefined || stamped.length === 0) return e;
            return { ...e, payload: Object.fromEntries(Object.entries(e.payload).filter(([k]) => !stamped.includes(k))) };
          }),
        })),
      };
      const sweep = soleScorerSweep(label, stripped, tapDivisionRefs);
      expect(sweep.checked, label).toBe(honest.checked);
      expect(sweep.offenders, label).toHaveLength(honest.checked);
    }
  });
});
