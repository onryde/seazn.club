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
import { describe, expect, it } from "vitest";
import en from "@/dictionaries/en/ui.json";
import { msgFor } from "@/lib/messages-i18n";
import type { MessageKey } from "@/lib/messages";
import type { Locale } from "@/lib/i18n-constants";
import { roundOnePairs, SWISS_PAIRINGS } from "@/lib/swiss-pairing";
import { swissActiveFieldSize } from "@/lib/swiss-legend";
import { planSwissShells } from "@/lib/swiss-shell";
import {
  swissFieldSeedsNumbered,
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
    });
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
  const numbered = { fieldSize: 10, seedsNumbered: true };

  it("numbers come from the engine's own pairing, first three, then an ellipsis", () => {
    const fold = roundOnePairs(10, "fold").slice(0, 3).map(([a, b]) => `${a}v${b}`).join(", ");
    expect(swissPairingHint("fold", numbered, t)).toBe(`${fold}…`);
    expect(swissPairingHint("fold", numbered, t)).toBe("1v6, 2v7, 3v8…"); // the prod case, spelled out once
    expect(swissPairingHint("rank_adjacent", numbered, t)).toBe("1v2, 3v4, 5v6…");
  });

  it("no ellipsis when every pair is shown", () => {
    expect(swissPairingHint("fold", { fieldSize: 4, seedsNumbered: true }, t)).toBe("1v3, 2v4");
    expect(swissPairingHint("fold", { fieldSize: 6, seedsNumbered: true }, t)).toBe("1v4, 2v5, 3v6");
  });

  it("R1: seeds that are not exactly 1..N get the generic line, never numbers", () => {
    const loose = { fieldSize: 10, seedsNumbered: false };
    expect(swissPairingHint("fold", loose, t)).toBe(en["schedule.pairing.hintFoldGeneric"]);
    expect(swissPairingHint("rank_adjacent", loose, t)).toBe(en["schedule.pairing.hintAdjacentGeneric"]);
    expect(swissPairingHint("fold", loose, t)).not.toMatch(/\d+v\d+/);
  });

  it("a field too small to pair gets the generic line rather than an empty one", () => {
    expect(swissPairingHint("fold", { fieldSize: 1, seedsNumbered: true }, t)).toBe(en["schedule.pairing.hintFoldGeneric"]);
  });

  it("the pair template is the locale's own ('c' in French, 't' in Dutch)", () => {
    expect(swissPairingHint("fold", numbered, tFor("fr"))).toBe("1c6, 2c7, 3c8…");
    expect(swissPairingHint("fold", numbered, tFor("nl"))).toBe("1t6, 2t7, 3t8…");
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
