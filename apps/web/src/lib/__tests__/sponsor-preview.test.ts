// R4 sponsors on stream, S12 - the On stream tab's preview (spec 2026-10-27 §5.1; ruling R11): the SAME pure planner, run over the
// breaks of a real finished match. `previewForSport` takes those breaks as input - it folds nothing and imports no engine - so the
// tab can recompute it on every tick and every dial move.
//
// Where the expected values come from (never from `previewForSport`):
//   - the dial: spec §3.2 "Light = every major; Normal = every major + every 3rd minor; Busy = every break";
//   - which breaks are major or minor: each sport's OWN `naturalBreaks.kinds` (the engine's declaration), read here;
//   - the cooldown: spec §3.2 "a 90 s cooldown between sponsor cards" (minors only, R4).
// The sweep is over EVERY shipped module that declares breaks (spec §3.1: 8 of the 11), and reports how many it checked.
import { describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { SPONSOR_COOLDOWN_MS, SponsorPlanInputError, type BreakOpened, type SponsorCard, type SponsorFrequency } from "@/lib/sponsor-plan";
import { previewForSport } from "../sponsor-preview";

const T0 = Date.parse("2026-10-31T10:00:00.000Z");
const MIN = 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();

const CARD: SponsorCard = { id: "c1", sponsorId: "s1", name: "Harbour", logoUrl: null, tier: "gold", onStream: true };
const FREQUENCIES: readonly SponsorFrequency[] = ["light", "normal", "busy"];

/** Four of each declared kind, five minutes apart (well outside the 90 s cooldown), sized by the SPORT'S declaration. */
function breaksOf(kinds: readonly { kind: string; size: "minor" | "major" }[]): BreakOpened[] {
  const out: BreakOpened[] = [];
  let seq = 0;
  for (let round = 0; round < 4; round++) {
    for (const k of kinds) {
      seq += 1;
      out.push({ seq, at: iso(T0 + seq * 5 * MIN), kind: k.kind, size: k.size });
    }
  }
  return out;
}

describe("previewForSport - the dial over a sport's own declared breaks", () => {
  it("every sport that declares breaks: Light = its majors, Busy = all, Normal = majors + every 3rd minor; cards follow (counted)", () => {
    let sports = 0;
    let cells = 0;
    for (const mod of builtinModules) {
      const kinds = mod.naturalBreaks?.kinds;
      if (kinds === undefined) continue;
      const breaks = breaksOf(kinds);
      const majors = breaks.filter((b) => b.size === "major").length;
      const minors = breaks.filter((b) => b.size === "minor").length;
      expect(majors, `${mod.key}: premise - declares a major`).toBeGreaterThan(0);
      expect(minors, `${mod.key}: premise - declares a minor`).toBeGreaterThan(0);
      const want: Record<SponsorFrequency, number> = {
        light: majors,
        normal: majors + Math.floor(minors / 3),
        busy: majors + minors,
      };
      for (const f of FREQUENCIES) {
        const got = previewForSport(f, breaks, [CARD]);
        expect(got.breaks, `${mod.key} ${f}: breaks`).toBe(want[f]);
        // Five minutes apart: no minor is thinned by the 90 s cooldown, so every eligible break draws a card.
        expect(got.cards, `${mod.key} ${f}: cards`).toBe(want[f]);
        cells++;
      }
      sports++;
    }
    expect(sports, "the spec names 8 sports with breaks").toBe(8);
    expect(cells).toBe(8 * 3);
  });

  it("a sport that declares no breaks has nothing to preview: generic, boardgame and carrom (counted)", () => {
    const without = builtinModules.filter((m) => m.naturalBreaks === undefined).map((m) => m.key).sort();
    expect(without).toEqual(["boardgame", "carrom", "generic"]);
    for (const f of FREQUENCIES) expect(previewForSport(f, [], [CARD])).toEqual({ breaks: 0, cards: 0 });
  });
});

describe("previewForSport - the planner's other rules reach the count", () => {
  const minor = (seq: number, atMs: number): BreakOpened => ({ seq, at: iso(atMs), kind: "timeout", size: "minor" });
  const major = (seq: number, atMs: number): BreakOpened => ({ seq, at: iso(atMs), kind: "set_end", size: "major" });

  it("the 90 s cooldown thins MINOR breaks only: 0, 30, 60, 120 s on Busy -> breaks 4, cards 2 (the 30 s and 60 s minors are thinned)", () => {
    const breaks = [0, 30, 60, 120].map((s, i) => minor(i + 1, T0 + s * 1000));
    expect(previewForSport("busy", breaks, [CARD])).toEqual({ breaks: 4, cards: 2 });
    expect(SPONSOR_COOLDOWN_MS, "premise: the spec's 90 s").toBe(90_000);
  });

  it("a MAJOR inside the cooldown still draws its card, and starts a new cooldown for the minor after it", () => {
    // minor@0 (card), major@30 s (card, cooldown restarts at 30 s), minor@100 s: 70 s after the major -> thinned.
    const breaks = [minor(1, T0), major(2, T0 + 30_000), minor(3, T0 + 100_000)];
    expect(previewForSport("busy", breaks, [CARD])).toEqual({ breaks: 3, cards: 2 });
  });

  it("no ticked sponsor: the breaks are counted, no card is drawn", () => {
    const breaks = [major(1, T0), major(2, T0 + 10 * MIN)];
    expect(previewForSport("light", breaks, [])).toEqual({ breaks: 2, cards: 0 });
    expect(previewForSport("light", breaks, [CARD])).toEqual({ breaks: 2, cards: 2 });
  });

  it("is pure: frozen inputs, and a second call answers the same (the sequence)", () => {
    const breaks = Object.freeze([Object.freeze(minor(1, T0)), Object.freeze(major(2, T0 + MIN))]);
    const cards = Object.freeze([Object.freeze({ ...CARD })]);
    const first = previewForSport("busy", breaks, cards);
    expect(previewForSport("busy", breaks, cards)).toEqual(first);
    expect(first).toEqual({ breaks: 2, cards: 2 });
  });

  it("an unknown frequency is refused, never read as a default (the planner's own guard)", () => {
    expect(() => previewForSport("loud" as SponsorFrequency, [major(1, T0)], [CARD])).toThrow(SponsorPlanInputError);
  });
});
