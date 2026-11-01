// The desk's round-1 pairing menu (spec 2026-09-22-swiss-round-one-pairing
// "UI"). Every derivation behind the split button lives in
// `@/lib/swiss-pairing-menu` as a pure function, because apps/web vitest is
// node-only: no test here can click the button, so anything left inline in a
// handler would be untested on exactly the path an organiser uses.
//
// Review rulings this file pins (task-4 brief, CONTROLLER AMENDMENTS):
//   R1  the hint never names a wrong seed — numbers only when the entrant at
//       pairing position k carries seed k, for every k; generic copy otherwise.
//   R2  fieldSize is the field swissGen pairs (registered/confirmed, and the
//       qualifier intersection on a stage carrying config.qualified).
//   R3  no menu when no round is waiting to be paired.
//   X-SW-22 (W3 T8) an unseeded round 1 is the stage's seeded random draw, so the
//       round-1 menu says so — only when the field it pairs holds an unseeded entrant.
import { describe, expect, it } from "vitest";
import en from "@/dictionaries/en/ui.json";
import { msgFor } from "@/lib/messages-i18n";
import type { MessageKey } from "@/lib/messages";
import type { Locale } from "@/lib/i18n-constants";
import { roundOnePairs, SWISS_PAIRINGS } from "@/lib/swiss-pairing";
import { swissActiveFieldSize } from "@/lib/swiss-legend";
import { planSwissShells } from "@/lib/swiss-shell";
import {
  swissFieldDrawn,
  swissFieldSeedsNumbered,
  swissPairingDrawNote,
  swissPairingForKey,
  swissPairingHint,
  swissPairingMenuFor,
  swissPairingOptionLabel,
  swissPairingOverride,
  type SwissPairingMenu,
} from "@/lib/swiss-pairing-menu";

/** The real catalog, per locale — never a stub, so a missing key reds here. */
const tFor = (locale: Locale) => (key: string, vars?: Record<string, string | number>) =>
  msgFor(locale, key as MessageKey, vars);
const t = tFor("en");

/** Shell rows exactly as `planSwissShells` mints them, all unseated. */
function shells(rounds: number, entrants: number) {
  return planSwissShells(rounds, entrants).map((s) => ({
    round_no: s.roundNo,
    home_entrant_id: null as string | null,
    away_entrant_id: null as string | null,
    outcome: null as unknown,
    ext_key: s.extKey as string | null,
  }));
}

/** Seat every board of `round` (a bye shell as a one-sided award). */
function seatRound(rows: ReturnType<typeof shells>, round: number) {
  return rows.map((r) =>
    r.round_no !== round
      ? r
      : r.ext_key?.includes("bye")
        ? { ...r, home_entrant_id: "x", outcome: { kind: "award" } }
        : { ...r, home_entrant_id: "h", away_entrant_id: "a" },
  );
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => `e${i + 1}`);
const seedsOf = (pairs: Array<[string, number | null]>) => Object.fromEntries(pairs);
/** e1..eN seeded 1..N. */
const seeded = (n: number) => seedsOf(ids(n).map((id, i) => [id, i + 1]));

describe("swissFieldSeedsNumbered — may the hint print seed NUMBERS? (R1)", () => {
  // Empty case FIRST (AGENTS: a rule set states its empty case first).
  it("an unknown roster or unknown seeds ⇒ no numbers", () => {
    expect(swissFieldSeedsNumbered({}, undefined, seeded(4))).toBe(false);
    expect(swissFieldSeedsNumbered({}, ids(4), undefined)).toBe(false);
    expect(swissFieldSeedsNumbered({}, [], {})).toBe(false);
  });

  it("a field too small to pair ⇒ no numbers (never a vacuous 'every seed matches')", () => {
    expect(swissFieldSeedsNumbered({}, ids(1), seeded(1))).toBe(false);
  });

  it("seeds exactly 1..N, one each ⇒ numbers", () => {
    expect(swissFieldSeedsNumbered({}, ids(10), seeded(10))).toBe(true);
  });

  it("…whatever order the roster lists them in — swissGen orders by seed", () => {
    const shuffled = ["e3", "e1", "e4", "e2"];
    expect(swissFieldSeedsNumbered({}, shuffled, seeded(4))).toBe(true);
  });

  it.each([
    ["a gap (1,2,4,5)", seedsOf([["e1", 1], ["e2", 2], ["e3", 4], ["e4", 5]])],
    ["an unseeded entrant", seedsOf([["e1", 1], ["e2", 2], ["e3", 3], ["e4", null]])],
    ["a duplicate seed", seedsOf([["e1", 1], ["e2", 2], ["e3", 2], ["e4", 4]])],
    ["seeds not starting at 1", seedsOf([["e1", 2], ["e2", 3], ["e3", 4], ["e4", 5]])],
    ["nobody seeded", seedsOf([["e1", null], ["e2", null], ["e3", null], ["e4", null]])],
  ])("%s ⇒ no numbers — position k would not be seed k", (_label, seeds) => {
    expect(swissFieldSeedsNumbered({}, ids(4), seeds)).toBe(false);
  });

  it("a departed entrant's seed does not count — only the active field is paired", () => {
    // e3 withdrew: the live field is e1,e2,e4 with seeds 1,2,4 — a gap.
    expect(swissFieldSeedsNumbered({}, ["e1", "e2", "e4"], seeded(4))).toBe(false);
  });

  describe("a stage drawing from config.qualified pairs in QUALIFICATION order", () => {
    it("qualifier k carrying seed k ⇒ numbers", () => {
      const config = { qualified: ["e1", "e2", "e3", "e4"] };
      expect(swissFieldSeedsNumbered(config, ids(6), seeded(6))).toBe(true);
    });
    it("the same four seeds in another qualification order ⇒ no numbers (the set alone is not enough)", () => {
      // Position 1 is e2 (seed 2): printing "1v3" would name seed 1 for e2.
      const config = { qualified: ["e2", "e1", "e3", "e4"] };
      expect(swissFieldSeedsNumbered(config, ids(6), seeded(6))).toBe(false);
    });
    it("a departed qualifier is dropped before positions are counted (swissGen expunges)", () => {
      const config = { qualified: ["e1", "e5", "e2", "e3"] };
      // e5 left: the live qualifiers are e1,e2,e3 at positions 1,2,3.
      expect(swissFieldSeedsNumbered(config, ["e1", "e2", "e3", "e4"], seeded(5))).toBe(true);
    });
  });
});

describe("swissFieldDrawn — does round 1 draw an unseeded entrant? (X-SW-22)", () => {
  // Empty case FIRST: nothing known, or nothing to pair, draws nobody.
  it("an unknown roster or unknown seeds, an empty field, or a field too small to pair ⇒ no draw", () => {
    expect(swissFieldDrawn({}, undefined, seedsOf([["e1", null], ["e2", null]]))).toBe(false);
    expect(swissFieldDrawn({}, ids(2), undefined)).toBe(false);
    expect(swissFieldDrawn({}, [], {})).toBe(false);
    // The Pair refuses a field under two (STAGE_NOT_READY): there is no round 1 to draw.
    expect(swissFieldDrawn({}, ids(1), seedsOf([["e1", null]]))).toBe(false);
  });

  it("a wholly seeded field ⇒ no draw (seed order stands)", () => {
    expect(swissFieldDrawn({}, ids(6), seeded(6))).toBe(false);
  });

  it.each([
    ["one unseeded entrant", seedsOf([["e1", 1], ["e2", 2], ["e3", null], ["e4", 4]])],
    ["nobody seeded", seedsOf([["e1", null], ["e2", null], ["e3", null], ["e4", null]])],
    ["a seed the roster map does not carry (read as unseeded, as swissFieldSeedsNumbered does)", seedsOf([["e1", 1], ["e2", 2], ["e3", 3]])],
  ])("%s ⇒ drawn", (_label, seeds) => {
    expect(swissFieldDrawn({}, ids(4), seeds)).toBe(true);
  });

  it("a departed unseeded entrant does not count — only the active field is paired", () => {
    expect(swissFieldDrawn({}, ["e1", "e2", "e4"], seedsOf([["e1", 1], ["e2", 2], ["e3", null], ["e4", 4]]))).toBe(false);
  });

  it("a stage drawing from config.qualified ranks by qualification order: never drawn, seeds or none", () => {
    const config = { qualified: ["e1", "e2", "e3", "e4"] };
    expect(swissFieldDrawn(config, ids(4), seedsOf([["e1", null], ["e2", null], ["e3", null], ["e4", null]]))).toBe(false);
  });
});

describe("swissPairingMenuFor — when the menu exists, and what it carries", () => {
  const base = {
    kind: "swiss",
    config: { rounds: 3 } as Record<string, unknown>,
    activeEntrantIds: ids(10),
    entrantSeeds: seeded(10),
  };

  // Empty case FIRST.
  it("no fixtures (first Generate mints the shells) ⇒ no menu", () => {
    expect(swissPairingMenuFor({ ...base, fixtures: [] })).toBeNull();
  });

  it("a non-swiss stage ⇒ no menu, even with unseated rows", () => {
    expect(swissPairingMenuFor({ ...base, kind: "league", fixtures: shells(3, 10) })).toBeNull();
  });

  it("R3: every round seated (nextUnseatedSwissRound is null) ⇒ no menu", () => {
    let rows = shells(2, 10);
    rows = seatRound(seatRound(rows, 1), 2);
    expect(swissPairingMenuFor({ ...base, fixtures: rows })).toBeNull();
  });

  it("round 1 waiting ⇒ choosable, default fold even on a Hammes stage", () => {
    const menu = swissPairingMenuFor({
      ...base,
      config: { rounds: 3, pairing: "rank_adjacent" },
      fixtures: shells(3, 10),
    });
    expect(menu).toEqual({
      round: 1,
      choosable: true,
      defaultPairing: "fold",
      stored: "rank_adjacent",
      fieldSize: 10,
      seedsNumbered: true,
      unseededDrawn: false,
      seededAheadOfDraw: false,
    });
  });

  it("X-SW-22 round 1 over a field with an unseeded entrant ⇒ the menu carries the draw; round 2 never does", () => {
    const seeds = { ...seeded(10), e7: null };
    const r1 = swissPairingMenuFor({ ...base, entrantSeeds: seeds, fixtures: shells(3, 10) });
    expect(r1).toMatchObject({ round: 1, choosable: true, seedsNumbered: false, unseededDrawn: true, seededAheadOfDraw: true });
    // Nobody seeded: drawn, and no seed goes first.
    const none = seedsOf(ids(10).map((id) => [id, null]));
    expect(swissPairingMenuFor({ ...base, entrantSeeds: none, fixtures: shells(3, 10) })).toMatchObject({
      unseededDrawn: true,
      seededAheadOfDraw: false,
    });
    // The draw is round 1's alone (later rounds rank by score, then the field's order).
    const r2 = swissPairingMenuFor({ ...base, entrantSeeds: seeds, fixtures: seatRound(shells(3, 10), 1) });
    expect(r2).toMatchObject({ round: 2, unseededDrawn: false, seededAheadOfDraw: false });
  });

  it("round 2 waiting ⇒ read-only, default is the stored mode", () => {
    const rows = seatRound(shells(3, 10), 1);
    const hammes = swissPairingMenuFor({ ...base, config: { rounds: 3, pairing: "rank_adjacent" }, fixtures: rows });
    expect(hammes).toMatchObject({ round: 2, choosable: false, defaultPairing: "rank_adjacent", stored: "rank_adjacent" });
    const plain = swissPairingMenuFor({ ...base, fixtures: rows });
    expect(plain).toMatchObject({ round: 2, choosable: false, defaultPairing: "fold", stored: "fold" });
  });

  it("an odd field's round 1 is still round 1 with its bye already awarded (spec ruling 1)", () => {
    // The partly-seated round 1 #831's Unpair rescues: the bye is minted as a
    // decided award at seat time, the boards are empty. Round NUMBER decides.
    const rows = shells(3, 7).map((r) =>
      r.round_no === 1 && r.ext_key?.includes("bye")
        ? { ...r, home_entrant_id: "e7", outcome: { kind: "award", winner: "e7" } }
        : r,
    );
    const menu = swissPairingMenuFor({ ...base, activeEntrantIds: ids(7), entrantSeeds: seeded(7), fixtures: rows });
    expect(menu).toMatchObject({ round: 1, choosable: true, fieldSize: 7 });
  });

  it("R2: fieldSize is the field swissGen pairs — the qualifier intersection, not the roster", () => {
    const config = { rounds: 3, qualified: ["e1", "e2", "e3", "e4", "gone"] };
    const menu = swissPairingMenuFor({ ...base, config, fixtures: shells(3, 4) });
    expect(menu?.fieldSize).toBe(4);
    // One authority: the same figure the swiss legend prints.
    expect(menu?.fieldSize).toBe(swissActiveFieldSize(config, base.activeEntrantIds));
  });

  it("an unknown roster still offers the menu, with generic hints (fieldSize 0, no numbers)", () => {
    const menu = swissPairingMenuFor({ ...base, activeEntrantIds: undefined, fixtures: shells(3, 10) });
    expect(menu).toMatchObject({ round: 1, choosable: true, fieldSize: 0, seedsNumbered: false });
  });
});

describe("swissPairingHint — the line under each option", () => {
  /** A round 1 nobody draws (every entrant seeded). */
  const undrawn = { unseededDrawn: false, seededAheadOfDraw: false };
  const numbered = { fieldSize: 10, seedsNumbered: true, ...undrawn };

  it("numbers come from the engine's own pairing, first three, then an ellipsis", () => {
    const fold = roundOnePairs(10, "fold").slice(0, 3).map(([a, b]) => `${a}v${b}`).join(", ");
    expect(swissPairingHint("fold", numbered, t)).toBe(`${fold}…`);
    expect(swissPairingHint("fold", numbered, t)).toBe("1v6, 2v7, 3v8…"); // the prod case, spelled out once
    expect(swissPairingHint("rank_adjacent", numbered, t)).toBe("1v2, 3v4, 5v6…");
  });

  it("no ellipsis when every pair is shown", () => {
    expect(swissPairingHint("fold", { fieldSize: 4, seedsNumbered: true, ...undrawn }, t)).toBe("1v3, 2v4");
    expect(swissPairingHint("fold", { fieldSize: 6, seedsNumbered: true, ...undrawn }, t)).toBe("1v4, 2v5, 3v6");
  });

  it("R1: seeds that are not exactly 1..N get the generic line, never numbers", () => {
    const loose = { fieldSize: 10, seedsNumbered: false, ...undrawn };
    expect(swissPairingHint("fold", loose, t)).toBe(en["schedule.pairing.hintFoldGeneric"]);
    expect(swissPairingHint("rank_adjacent", loose, t)).toBe(en["schedule.pairing.hintAdjacentGeneric"]);
    expect(swissPairingHint("fold", loose, t)).not.toMatch(/\d+v\d+/);
  });

  it("a field too small to pair gets the generic line rather than an empty one", () => {
    expect(swissPairingHint("fold", { fieldSize: 1, seedsNumbered: true, ...undrawn }, t)).toBe(en["schedule.pairing.hintFoldGeneric"]);
  });

  // Review m1 (copy truth): a drawn round 1 is not "by seed". A wholly unseeded field has no seed at all — its halves are
  // the draw's; a partly seeded field puts its seeds first, then the draw. "by seed" alone is true only undrawn.
  it("m1 a wholly unseeded round 1 never says 'by seed': its halves and neighbours are the draw's", () => {
    const drawn = { fieldSize: 8, seedsNumbered: false, unseededDrawn: true, seededAheadOfDraw: false };
    expect(swissPairingHint("fold", drawn, t)).toBe(en["schedule.pairing.hintFoldDrawn"]);
    expect(swissPairingHint("rank_adjacent", drawn, t)).toBe(en["schedule.pairing.hintAdjacentDrawn"]);
    expect(en["schedule.pairing.hintFoldDrawn"]).toBe("top half v bottom half of the draw");
    expect(en["schedule.pairing.hintAdjacentDrawn"]).toBe("1st v 2nd, 3rd v 4th in draw order");
    for (const mode of SWISS_PAIRINGS) expect(swissPairingHint(mode, drawn, t), mode).not.toMatch(/by seed/);
  });

  it("m1 a partly seeded round 1 says the seeds come first, then the draw", () => {
    const partly = { fieldSize: 8, seedsNumbered: false, unseededDrawn: true, seededAheadOfDraw: true };
    expect(swissPairingHint("fold", partly, t)).toBe(en["schedule.pairing.hintFoldSeededDrawn"]);
    expect(swissPairingHint("rank_adjacent", partly, t)).toBe(en["schedule.pairing.hintAdjacentSeededDrawn"]);
    expect(en["schedule.pairing.hintFoldSeededDrawn"]).toBe("top half v bottom half by seed, then the draw");
    expect(en["schedule.pairing.hintAdjacentSeededDrawn"]).toBe("1st v 2nd, 3rd v 4th by seed, then the draw");
  });

  it("m1 every locale has the four drawn hints in its own words", () => {
    let checked = 0;
    const keys = [
      "schedule.pairing.hintFoldDrawn",
      "schedule.pairing.hintAdjacentDrawn",
      "schedule.pairing.hintFoldSeededDrawn",
      "schedule.pairing.hintAdjacentSeededDrawn",
    ] as const;
    for (const locale of ["es", "fr", "nl"] as const) {
      for (const key of keys) {
        const line = tFor(locale)(key);
        // A missing key comes back as the key itself — truthy and unlike English — so pin both away.
        expect(en[key], `en ${key} exists`).toBeTruthy();
        expect(line, `${locale} ${key}: a string, not the key`).not.toBe(key);
        expect(line, `${locale} ${key}: not English`).not.toBe(en[key]);
        checked++;
      }
    }
    expect(checked).toBe(12);
  });

  it("the pair template is the locale's own ('c' in French, 't' in Dutch)", () => {
    expect(swissPairingHint("fold", numbered, tFor("fr"))).toBe("1c6, 2c7, 3c8…");
    expect(swissPairingHint("fold", numbered, tFor("nl"))).toBe("1t6, 2t7, 3t8…");
  });
});

describe("swissPairingDrawNote — the round-1 line when the field is drawn (X-SW-22)", () => {
  const menu = { choosable: true, unseededDrawn: true };
  // Empty case FIRST: no draw, no line.
  it("no unseeded entrant ⇒ no line; a read-only later round ⇒ no line", () => {
    expect(swissPairingDrawNote({ choosable: true, unseededDrawn: false }, t)).toBeNull();
    expect(swissPairingDrawNote({ choosable: false, unseededDrawn: true }, t)).toBeNull();
  });

  it("a drawn round 1 ⇒ the catalog's own line", () => {
    expect(swissPairingDrawNote(menu, t)).toBe(en["schedule.pairing.drawnAtRandom"]);
    // Review m9: the desk's noun for a field is "entrants" (a team Swiss is drawn too), never "players".
    expect(en["schedule.pairing.drawnAtRandom"]).toBe("Unseeded entrants are drawn at random.");
  });

  it("every locale says it in its own words, never the English fallback", () => {
    let checked = 0;
    for (const locale of ["es", "fr", "nl"] as const) {
      const line = swissPairingDrawNote(menu, tFor(locale));
      expect(line, locale).toBeTruthy();
      expect(line, `${locale}: not English`).not.toBe(en["schedule.pairing.drawnAtRandom"]);
      expect(line, `${locale}: the desk's noun, not "players"`).not.toMatch(/jugador|joueur|speler/i);
      checked++;
    }
    expect(checked).toBe(3);
  });
});

describe("swissPairingOptionLabel", () => {
  it("marks the default, and only the default", () => {
    expect(swissPairingOptionLabel("fold", "fold", t)).toBe("Top vs bottom (default)");
    expect(swissPairingOptionLabel("rank_adjacent", "fold", t)).toBe("Neighbours");
    expect(swissPairingOptionLabel("rank_adjacent", "rank_adjacent", t)).toBe("Neighbours (default)");
    expect(swissPairingOptionLabel("fold", "rank_adjacent", t)).toBe("Top vs bottom");
  });
});

describe("swissPairingOverride — what Pair next sends", () => {
  const menu: SwissPairingMenu = {
    round: 1,
    choosable: true,
    defaultPairing: "fold",
    stored: "rank_adjacent",
    fieldSize: 8,
    seedsNumbered: true,
    unseededDrawn: false,
    seededAheadOfDraw: false,
  };

  // Empty case FIRST.
  it("no menu, or no pick ⇒ nothing (the desk's plain {} body)", () => {
    expect(swissPairingOverride(null, null)).toBeUndefined();
    expect(swissPairingOverride("rank_adjacent", null)).toBeUndefined();
    expect(swissPairingOverride(null, menu)).toBeUndefined();
  });

  it("picking the default sends nothing — the server's own default decides", () => {
    expect(swissPairingOverride("fold", menu)).toBeUndefined();
  });

  it("picking the other mode sends it", () => {
    expect(swissPairingOverride("rank_adjacent", menu)).toEqual({ pairing: "rank_adjacent" });
  });

  it("never sends a pick outside round 1 — the server would 422 it", () => {
    const later = { ...menu, round: 2, choosable: false, defaultPairing: "rank_adjacent" as const };
    expect(swissPairingOverride("fold", later)).toBeUndefined();
  });
});

describe("swissPairingForKey — radiogroup keyboard (WAI-ARIA radio pattern)", () => {
  it("the menu order is the one authority's order", () => {
    expect(SWISS_PAIRINGS).toEqual(["fold", "rank_adjacent"]);
  });
  it.each([
    ["ArrowDown", "fold", "rank_adjacent"],
    ["ArrowRight", "fold", "rank_adjacent"],
    ["ArrowDown", "rank_adjacent", "fold"], // wraps
    ["ArrowUp", "rank_adjacent", "fold"],
    ["ArrowLeft", "rank_adjacent", "fold"],
    ["ArrowUp", "fold", "rank_adjacent"], // wraps
    ["Home", "rank_adjacent", "fold"],
    ["End", "fold", "rank_adjacent"],
  ] as const)("%s from %s ⇒ %s", (key, from, to) => {
    expect(swissPairingForKey(key, from)).toBe(to);
  });
  it("any other key is left to the browser (Tab still leaves the group)", () => {
    expect(swissPairingForKey("Tab", "fold")).toBeNull();
    expect(swissPairingForKey("a", "fold")).toBeNull();
  });
});
