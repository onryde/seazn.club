// RS006 step 3 (DETAILS) — roster parse/serialize/wire-mapping (pure, no
// DOM). parseRoster is recovered verbatim (token-classification-wise) from
// git history (76ef7987b:apps/web/src/components/public-site/
// register-form.tsx:76-93) — same tests as that shape would have needed,
// plus the round-trip property test the RS006 dispatch calls for.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { effectiveSelfDob, effectiveSelfPlayers, parseRoster, serializeRoster, toGroupPlayer, toGroupPlayers } from "../roster";
import { EMPTY_ROSTER_PLAYER, type CartEntry, type RosterPlayerState } from "../types";

function player(overrides: Partial<RosterPlayerState>): RosterPlayerState {
  return { ...EMPTY_ROSTER_PLAYER, ...overrides };
}

describe("parseRoster — recovered from git history 76ef7987b", () => {
  it("one player per line, name only", () => {
    expect(parseRoster("Jordan Blake\nSam Ortiz")).toEqual([
      player({ full_name: "Jordan Blake" }),
      player({ full_name: "Sam Ortiz" }),
    ]);
  });

  it("comma tokens in ANY order — squad number and dob both recognised positionally-agnostic", () => {
    expect(parseRoster("Jordan Blake, 7")).toEqual([player({ full_name: "Jordan Blake", squad_number: "7" })]);
    expect(parseRoster("7, Jordan Blake")).toEqual([player({ full_name: "Jordan Blake", squad_number: "7" })]);
    expect(parseRoster("Sam Ortiz, 10, 2004-11-30")).toEqual([
      player({ full_name: "Sam Ortiz", squad_number: "10", dob: "2004-11-30" }),
    ]);
    expect(parseRoster("2004-11-30, Sam Ortiz, 10")).toEqual([
      player({ full_name: "Sam Ortiz", squad_number: "10", dob: "2004-11-30" }),
    ]);
  });

  it("bare 1-3 digit squad numbers only — a 4+ digit token is not a squad number token", () => {
    expect(parseRoster("Alex Kim, 007")).toEqual([player({ full_name: "Alex Kim", squad_number: "007" })]);
    // A 4-digit numeric token doesn't match the squad-number rule, and
    // (since "Alex Kim" already claimed the name slot) is silently dropped
    // — same recovered behaviour, not something this session changes.
    expect(parseRoster("Alex Kim, 1234")).toEqual([player({ full_name: "Alex Kim" })]);
  });

  it("blank lines and stray whitespace are ignored", () => {
    expect(parseRoster("  Jordan Blake  \n\n  Sam Ortiz\n")).toEqual([
      player({ full_name: "Jordan Blake" }),
      player({ full_name: "Sam Ortiz" }),
    ]);
  });

  it("a line with no name-shaped token at all falls back to the first raw token (recovered quirk, not fixed here)", () => {
    // A lone ISO-date token: the loop consumes it as dob, name stays "",
    // then the post-loop fallback re-uses parts[0] (the SAME date string)
    // as the name. This is the exact legacy behaviour being ported, not a
    // new decision.
    expect(parseRoster("2005-04-12")).toEqual([player({ full_name: "2005-04-12", dob: "2005-04-12" })]);
  });

  it("a name-less/empty line is dropped entirely", () => {
    expect(parseRoster("\n   \n")).toEqual([]);
    expect(parseRoster("")).toEqual([]);
  });

  it("extra unclaimed tokens beyond name/dob/squad are silently dropped", () => {
    expect(parseRoster("Jordan Blake, 7, 2004-11-30, extra, more")).toEqual([
      player({ full_name: "Jordan Blake", squad_number: "7", dob: "2004-11-30" }),
    ]);
  });
});

describe("serializeRoster — parseRoster's own inverse for its representable subset", () => {
  it("round-trips a simple typed-in roster", () => {
    const players = [player({ full_name: "Jordan Blake", squad_number: "7" }), player({ full_name: "Sam Ortiz", dob: "2004-11-30" })];
    expect(parseRoster(serializeRoster(players))).toEqual(players);
  });

  it("omits blank fields rather than emitting empty tokens", () => {
    const text = serializeRoster([player({ full_name: "Alex Kim" })]);
    expect(text).toBe("Alex Kim");
  });

  it("property: parse(serialize(x)) === x for the roster shapes the paste format can actually represent", () => {
    // Representable subset, and WHY each constraint is here (not a vacuous
    // narrowing — see the RS006 dispatch's own warning about that):
    //  - full_name drawn from letters+spaces only: a name that is ALL
    //    digits (1-3 chars) misparses as a squad number, and a name shaped
    //    like an ISO date misparses as a dob — both real parseRoster
    //    landmines, not paste-format edge cases a real name would ever hit.
    //  - squad_number restricted to 0-999: the WIRE schema itself caps it
    //    there (schemas.ts squad_number.min(0).max(999)), so a "4-digit
    //    squad number" is never a legal value this app would ever hold in
    //    the first place, not just an untested one.
    //  - gender/email/is_captain stay at their EMPTY_ROSTER_PLAYER defaults
    //    on both sides of the round trip: the historical paste format has
    //    no columns for them (parseRoster never produced them, port intact)
    //    — asserting they "round-trip" would be a fake win, not a real one.
    const nameArb = fc
      .stringOf(fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz ".split("")), {
        minLength: 1,
        maxLength: 24,
      })
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const squadArb = fc.oneof(fc.constant(""), fc.integer({ min: 0, max: 999 }).map(String));
    const dobArb = fc.oneof(
      fc.constant(null),
      fc
        .tuple(fc.integer({ min: 1950, max: 2020 }), fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1, max: 28 }))
        .map(([y, m, d]) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`),
    );
    const playerArb = fc.record({
      full_name: nameArb,
      squad_number: squadArb,
      dob: dobArb,
      gender: fc.constant(null),
      email: fc.constant(""),
      is_captain: fc.constant(false),
    });

    fc.assert(
      fc.property(fc.array(playerArb, { minLength: 1, maxLength: 20 }), (players) => {
        const roundTripped = parseRoster(serializeRoster(players));
        expect(roundTripped).toEqual(players);
      }),
    );
  });
});

describe("toGroupPlayer — one roster row onto PublicRegisterGroupPlayer's shape", () => {
  it("trims full_name/email, parses squad_number to an int, blank email/squad_number -> null", () => {
    expect(toGroupPlayer(player({ full_name: "  Alex Kim  ", email: " alex@example.com ", squad_number: "7" }))).toEqual({
      full_name: "Alex Kim",
      dob: null,
      gender: null,
      email: "alex@example.com",
      squad_number: 7,
      is_captain: undefined,
    });
    expect(toGroupPlayer(player({ full_name: "Sam Ortiz" }))).toEqual({
      full_name: "Sam Ortiz",
      dob: null,
      gender: null,
      email: null,
      squad_number: null,
      is_captain: undefined,
    });
  });

  it("is_captain true carries through; false maps to undefined (schema field is optional, not required-false)", () => {
    expect(toGroupPlayer(player({ full_name: "Cap", is_captain: true })).is_captain).toBe(true);
    expect(toGroupPlayer(player({ full_name: "NotCap", is_captain: false })).is_captain).toBeUndefined();
  });
});

describe("toGroupPlayers — drops blank-named TEAM rows, keeps individual/pair rows as-is", () => {
  it("a team roster drops rows with no name typed (never submitted as blank)", () => {
    const rows = [player({ full_name: "Real Name" }), player({ full_name: "" }), player({ full_name: "  " })];
    expect(toGroupPlayers(rows, "team").map((p) => p.full_name)).toEqual(["Real Name"]);
  });

  it("individual/pair rows are kept even blank (step 3's own validation, not this mapper, is what blocks Next on those)", () => {
    const rows = [player({ full_name: "" })];
    expect(toGroupPlayers(rows, "individual")).toHaveLength(1);
    expect(toGroupPlayers(rows, "pair")).toHaveLength(1);
  });
});

describe("effectiveSelfPlayers — presentation-only fallback of the self row's dob/gender to the WHO-step contact", () => {
  const contact = { dob: "1990-01-01" as string | null, gender: "f" as "m" | "f" | "x" | null };

  it("fills the self row's blank dob/gender from contact, leaves a filled row alone", () => {
    const players = [player({ full_name: "Self" }), player({ full_name: "Other" })];
    const effective = effectiveSelfPlayers(players, 0, contact);
    expect(effective[0]).toEqual(player({ full_name: "Self", dob: "1990-01-01", gender: "f" }));
    expect(effective[1]).toEqual(player({ full_name: "Other" })); // non-self row untouched
  });

  it("does not override a self row that already repeated its OWN dob/gender", () => {
    const players = [player({ full_name: "Self", dob: "2000-06-15", gender: "m" })];
    const effective = effectiveSelfPlayers(players, 0, contact);
    expect(effective[0]!.dob).toBe("2000-06-15");
    expect(effective[0]!.gender).toBe("m");
  });

  it("selfIndex null returns the SAME players (no merge, no self row to fall back)", () => {
    const players = [player({ full_name: "Solo" })];
    expect(effectiveSelfPlayers(players, null, contact)).toBe(players);
  });

  it("an out-of-range selfIndex degrades to the players unchanged rather than throwing", () => {
    const players = [player({ full_name: "Solo" })];
    expect(effectiveSelfPlayers(players, 5, contact)).toBe(players);
  });
});

describe("effectiveSelfDob — guardian-consent-bypass fix: the self row's OWN dob wins over contact.dob", () => {
  const contact = { dob: "1990-01-01" as string | null };

  type SelfEntry = Pick<CartEntry, "registering_self" | "self_player_index" | "entrant_kind" | "players">;
  function selfEntry(overrides: Partial<SelfEntry> = {}): SelfEntry {
    return {
      registering_self: true,
      self_player_index: 0,
      entrant_kind: "individual",
      players: [player({ full_name: "Self" })],
      ...overrides,
    };
  }

  it("not self-linked at all -> null, regardless of any dob on the roster", () => {
    expect(effectiveSelfDob(selfEntry({ registering_self: false }), contact)).toBeNull();
  });

  it("the self row's OWN dob wins over contact.dob — the bug this function exists to fix", () => {
    const e = selfEntry({ players: [player({ full_name: "Self", dob: "2015-01-01" })] });
    expect(effectiveSelfDob(e, contact)).toBe("2015-01-01");
  });

  it("falls back to contact.dob when the self row's own dob is blank", () => {
    const e = selfEntry({ players: [player({ full_name: "Self", dob: null })] });
    expect(effectiveSelfDob(e, contact)).toBe("1990-01-01");
  });

  it("individual kind resolves index 0 even though self_player_index stays null on the client (entry-details.tsx never renders a self-row picker for it)", () => {
    const e = selfEntry({ self_player_index: null, players: [player({ full_name: "Self", dob: "2015-01-01" })] });
    expect(effectiveSelfDob(e, contact)).toBe("2015-01-01");
  });

  it("a non-individual entry with an unresolved self_player_index falls back to contact.dob rather than reading the wrong row", () => {
    const e = selfEntry({
      entrant_kind: "team",
      self_player_index: null,
      players: [player({ full_name: "Other", dob: "2015-01-01" }), player({ full_name: "Self", dob: "2016-01-01" })],
    });
    expect(effectiveSelfDob(e, contact)).toBe("1990-01-01");
  });

  it("resolves an EXPLICIT self_player_index on a team entry, not just index 0", () => {
    const e = selfEntry({
      entrant_kind: "team",
      self_player_index: 1,
      players: [player({ full_name: "Other", dob: "1988-01-01" }), player({ full_name: "Self", dob: "2015-01-01" })],
    });
    expect(effectiveSelfDob(e, contact)).toBe("2015-01-01");
  });

  it("an out-of-range self_player_index degrades to contact.dob rather than throwing", () => {
    const e = selfEntry({ entrant_kind: "team", self_player_index: 5, players: [player({ full_name: "Self" })] });
    expect(effectiveSelfDob(e, contact)).toBe("1990-01-01");
  });
});
