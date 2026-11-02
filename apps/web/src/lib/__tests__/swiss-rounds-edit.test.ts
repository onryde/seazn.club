// W3 T12 Phase 2 (X-SW-17): the rounds dialog's preview — what Save removes or adds, and the stepper's bounds — pinned
// against the rulebook (§3.1 bounds: hard max n − 1 for an even field, n for an odd one; safe max ⌊n/2⌋; a round of a
// field of n holds ⌊n/2⌋ matches and, for an odd n, a bye that is no match). Expected values are typed here, never read
// off `swissRoundsEditPreview` or the helpers it calls.
import { describe, expect, it } from "vitest";
import {
  SWISS_ROUNDS_UNKNOWN_FIELD_MAX,
  swissRoundsEditPreview,
  type SwissRoundControl,
  type SwissRoundsEditFixture,
} from "@/lib/swiss-rounds-edit";

const HARD_MAX = (n: number) => (n % 2 === 0 ? n - 1 : n);

/** `rounds` rounds of unseated shells for a field of `n`, as the mint writes them (`sw-r{r}-b{k}`, `sw-r{r}-bye`). */
function shells(n: number, rounds: number): SwissRoundsEditFixture[] {
  const out: SwissRoundsEditFixture[] = [];
  for (let r = 1; r <= rounds; r++) {
    for (let b = 1; b <= Math.floor(n / 2); b++) {
      out.push({ round_no: r, ext_key: `sw-r${r}-b${b}`, home_entrant_id: null, away_entrant_id: null, outcome: null });
    }
    if (n % 2 === 1) out.push({ round_no: r, ext_key: `sw-r${r}-bye`, home_entrant_id: null, away_entrant_id: null, outcome: null });
  }
  return out;
}

/** Seat every board of round `r` (and award its bye), as Pair does. */
function seat(rows: SwissRoundsEditFixture[], r: number): SwissRoundsEditFixture[] {
  return rows.map((f) =>
    f.round_no !== r
      ? f
      : /-bye$/.test(f.ext_key ?? "")
        ? { ...f, home_entrant_id: "p-bye", outcome: { kind: "award" } }
        : { ...f, home_entrant_id: `h${f.ext_key}`, away_entrant_id: `a${f.ext_key}` },
  );
}

const control = (field: number | null, addField: number | null = field): Pick<SwissRoundControl, "field" | "addRound"> => ({
  field,
  addRound: { canAddRound: true, refusal: null, field: addField, hardMax: addField === null ? null : HARD_MAX(addField) },
});

describe("swissRoundsEditPreview (X-SW-17, the rounds dialog)", () => {
  it("the empty case: no shell yet — nothing removed or added (the count is only stored); bounds from the field", () => {
    const p = swissRoundsEditPreview({ fixtures: [], from: 5, to: 3, control: control(6) });
    expect(p).toEqual({
      min: 1,
      max: 5,
      drawn: false,
      removed: null,
      added: null,
      judgement: { verdict: "ok", recommended: 3, safeMax: 3, hardMax: 5 },
    });
    expect(swissRoundsEditPreview({ fixtures: [], from: 3, to: 4, control: control(6) }).added).toBeNull();
  });

  it("5 → 3 on a field of 6 removes rounds 4 to 5: 6 unplayed matches (the owner-approved mock's own example)", () => {
    const p = swissRoundsEditPreview({ fixtures: shells(6, 5), from: 5, to: 3, control: control(6) });
    expect(p.removed).toEqual({ from: 4, to: 5, matches: 6 });
    expect(p.added).toBeNull();
    expect(p.drawn).toBe(true);
  });

  it("an odd field: the removed rounds' byes are shells, not matches (5 → 3 on a field of 5 is 4 matches)", () => {
    const p = swissRoundsEditPreview({ fixtures: shells(5, 5), from: 5, to: 3, control: control(5) });
    expect(p.removed).toEqual({ from: 4, to: 5, matches: 4 });
    // One round down: a single round named.
    expect(swissRoundsEditPreview({ fixtures: shells(5, 5), from: 5, to: 4, control: control(5) }).removed).toEqual({ from: 5, to: 5, matches: 2 });
  });

  it("adding mints ⌊n/2⌋ matches per new round for round N + 1's field, n = 2..9 (anti-vacuity counted)", () => {
    let checked = 0;
    for (let n = 2; n <= 9; n++) {
      const p = swissRoundsEditPreview({ fixtures: shells(n, 1), from: 1, to: 2, control: control(n) });
      expect(p.added, `n=${n}`).toEqual({ from: 2, to: 2, matchesPerRound: Math.floor(n / 2) });
      expect(p.removed, `n=${n}`).toBeNull();
      checked++;
    }
    expect(checked, "anti-vacuity: field sizes checked").toBe(8);
    // Two rounds at once: the range, matches each.
    expect(swissRoundsEditPreview({ fixtures: shells(6, 3), from: 3, to: 5, control: control(6) }).added).toEqual({ from: 4, to: 5, matchesPerRound: 3 });
  });

  it("the added rounds are sized for round N + 1's field (a late player counted there), not the next Pair's", () => {
    // Next Pair seats 6; round 4 onwards counts a 7th, recorded after the last round.
    const p = swissRoundsEditPreview({ fixtures: shells(6, 3), from: 3, to: 4, control: control(6, 7) });
    expect(p.added).toEqual({ from: 4, to: 4, matchesPerRound: 3 });
    const q = swissRoundsEditPreview({ fixtures: shells(6, 3), from: 3, to: 4, control: control(6, 8) });
    expect(q.added, "a field of 8 holds 4 matches").toEqual({ from: 4, to: 4, matchesPerRound: 4 });
  });

  it("min is the latest round with a seat (SWISS_ROUNDS_BELOW_SEATED), max the field's hard maximum (SWISS_ROUNDS_ABOVE_MAX)", () => {
    const rows = seat(seat(shells(6, 5), 1), 2);
    const p = swissRoundsEditPreview({ fixtures: rows, from: 5, to: 4, control: control(6) });
    expect(p.min).toBe(2);
    expect(p.max).toBe(5);
    // A field of 4 shrunk under a stored 5 (carry c2): only lowering is offered; 5 itself refuses.
    const shrunk = swissRoundsEditPreview({ fixtures: shells(6, 5), from: 5, to: 5, control: control(4) });
    expect(shrunk.max).toBe(3);
    expect(shrunk.judgement).toMatchObject({ verdict: "refuse", hardMax: 3 });
    expect(swissRoundsEditPreview({ fixtures: shells(6, 5), from: 5, to: 3, control: control(4) }).judgement).toMatchObject({ verdict: "warn" });
  });

  it("no field known (a fed Swiss before its draw): no judgement, and the stepper's ceiling is the inputs' own 15", () => {
    const p = swissRoundsEditPreview({ fixtures: [], from: 3, to: 4, control: control(null) });
    expect(p.judgement).toBeNull();
    expect(p.max).toBe(SWISS_ROUNDS_UNKNOWN_FIELD_MAX);
    expect(SWISS_ROUNDS_UNKNOWN_FIELD_MAX).toBe(15);
    // A field under two is no pairable field either.
    expect(swissRoundsEditPreview({ fixtures: [], from: 3, to: 4, control: control(1) }).judgement).toBeNull();
  });
});
