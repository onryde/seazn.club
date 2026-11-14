// Polish wave P4 (walkthrough W1, W3): the registrant typed their own name on step 1 and ticked "I'm registering myself", then met an
// empty "Player 1" on the Details step and typed the same name again; a pair partner typed on Entries met an empty "Player 2". These are
// the rules for what Details starts with, from what the earlier steps already collected. Literals are the walkthrough's own.
//
// Registration redesign B2 T10: a row the form SEEDED from Contact follows a later Contact rename, because the Details step shows that
// row read-only as "That's you" while its name matches Contact (roster.ts contactRowIndex) - a rename that left the old name behind would
// unlock the row. A row the registrant edited is theirs and is never overwritten. The test of "untouched" is: the row still holds the
// value Contact last gave it (`CartEntry.seeded_from`, written by the seed itself and kept with the cart).
import { describe, expect, it } from "vitest";
import { seedDetailsRows } from "../details-seed";
import {
  EMPTY_CART,
  EMPTY_CONTACT,
  EMPTY_ROSTER_PLAYER,
  type CartEntry,
  type CartState,
  type ContactState,
  type DivisionLike,
} from "../types";

const DIV: DivisionLike = {
  division_id: "div-1",
  name: "Open Singles",
  entrant_kind: "individual",
  category: null,
  age_min: null,
  age_max: null,
  requires_dob: false,
  requires_gender: false,
  allow_free_agents: false,
  open: true,
  closed_reason: null,
  capacity: null,
  remaining: null,
  taken: 0,
  opens_at: null,
  closes_at: null,
  fee_cents: 1500,
  free_agent_fee_cents: null,
  currency: "gbp",
  payment_method: "stripe",
  form_fields: [],
};

const entry = (kind: CartEntry["entrant_kind"], patch: Partial<CartEntry> = {}): CartEntry => ({
  id: `e-${kind}`,
  division_id: "div-1",
  entrant_kind: kind,
  team_name: null,
  partner_name: null,
  free_agent: false,
  players: Array.from({ length: kind === "individual" ? 1 : kind === "pair" ? 2 : 0 }, () => ({ ...EMPTY_ROSTER_PLAYER })),
  answers: {},
  registering_self: false,
  self_player_index: null,
  self_link_declined: false,
  ...patch,
});

const cartOf = (...entries: CartEntry[]): CartState => ({ entries });
const contact = (patch: Partial<ContactState> = {}): ContactState => ({
  ...EMPTY_CONTACT,
  name: "Mia Cole",
  email: "mia@example.com",
  ...patch,
});
const names = (e: CartEntry) => e.players.map((p) => p.full_name);

describe("seedDetailsRows: an individual who is registering themselves", () => {
  it("Player 1 starts as the contact's own name (the walkthrough's W1: 'Mia Cole' typed twice)", () => {
    const out = seedDetailsRows(cartOf(entry("individual", { registering_self: true })), contact(), [DIV]);
    expect(names(out.entries[0]!)).toEqual(["Mia Cole"]);
  });

  it("a name with stray spaces is carried trimmed, and a blank contact name seeds nothing", () => {
    const padded = seedDetailsRows(cartOf(entry("individual", { registering_self: true })), contact({ name: "  Mia Cole " }), [DIV]);
    expect(names(padded.entries[0]!)).toEqual(["Mia Cole"]);
    const cart = cartOf(entry("individual", { registering_self: true }));
    expect(seedDetailsRows(cart, contact({ name: "   " }), [DIV]), "blank name: the SAME reference, nothing to do").toBe(cart);
  });

  it("an individual NOT registering themselves (someone entering another person) is left blank", () => {
    const cart = cartOf(entry("individual"));
    const out = seedDetailsRows(cart, contact(), [DIV]);
    expect(out).toBe(cart);
    expect(names(out.entries[0]!)).toEqual([""]);
  });

  it("a second call changes nothing; a name the registrant typed over the seed is never overwritten, even by a rename; an untouched one follows the rename", () => {
    const first = seedDetailsRows(cartOf(entry("individual", { registering_self: true })), contact(), [DIV]);
    expect(seedDetailsRows(first, contact(), [DIV]), "idempotent: the same reference").toBe(first);
    const edited: CartState = {
      entries: [{ ...first.entries[0]!, players: [{ ...first.entries[0]!.players[0]!, full_name: "Amelia Cole" }] }],
    };
    expect(names(seedDetailsRows(edited, contact(), [DIV]).entries[0]!), "the typed name survives a re-entry into Details").toEqual(["Amelia Cole"]);
    const renamed = contact({ name: "Maya Cole" });
    expect(names(seedDetailsRows(edited, renamed, [DIV]).entries[0]!), "...and survives a rename too: it is theirs now").toEqual(["Amelia Cole"]);
    expect(names(seedDetailsRows(first, renamed, [DIV]).entries[0]!), "the untouched seed follows the rename").toEqual(["Maya Cole"]);
  });

  it("dob and gender follow only when the division asks for them (so a visible empty required field is never shown beside a known answer)", () => {
    const who = contact({ dob: "1990-04-02", gender: "f" });
    const asks = seedDetailsRows(cartOf(entry("individual", { registering_self: true })), who, [{ ...DIV, requires_dob: true, requires_gender: true }]);
    expect(asks.entries[0]!.players[0]).toMatchObject({ full_name: "Mia Cole", dob: "1990-04-02", gender: "f" });
    const silent = seedDetailsRows(cartOf(entry("individual", { registering_self: true })), who, [DIV]);
    expect(silent.entries[0]!.players[0]).toMatchObject({ full_name: "Mia Cole", dob: null, gender: null });
    const typed = { ...entry("individual", { registering_self: true }) };
    typed.players = [{ ...EMPTY_ROSTER_PLAYER, dob: "1985-01-01" }];
    expect(
      seedDetailsRows(cartOf(typed), who, [{ ...DIV, requires_dob: true }]).entries[0]!.players[0]!.dob,
      "a row's own dob is never replaced by the contact's",
    ).toBe("1985-01-01");
  });
});

describe("seedDetailsRows: a pair", () => {
  it("W3: the partner typed on Entries lands on Player 2; Player 1 stays blank when nobody is registering themselves", () => {
    const out = seedDetailsRows(cartOf(entry("pair", { partner_name: "Sam Reid" })), contact(), [DIV]);
    expect(names(out.entries[0]!)).toEqual(["", "Sam Reid"]);
    expect(out.entries[0]!.self_player_index).toBeNull();
  });

  it("registering themselves: Player 1 is the contact AND the self pick is set to it, the partner still lands on Player 2", () => {
    const out = seedDetailsRows(cartOf(entry("pair", { registering_self: true, partner_name: "Sam Reid" })), contact(), [DIV]);
    expect(names(out.entries[0]!)).toEqual(["Mia Cole", "Sam Reid"]);
    expect(out.entries[0]!.self_player_index).toBe(0);
  });

  it("an explicit self pick of Player 2 is honoured: the contact goes there and the partner takes Player 1", () => {
    const out = seedDetailsRows(
      cartOf(entry("pair", { registering_self: true, self_player_index: 1, partner_name: "Sam Reid" })),
      contact(),
      [DIV],
    );
    expect(names(out.entries[0]!)).toEqual(["Sam Reid", "Mia Cole"]);
    expect(out.entries[0]!.self_player_index).toBe(1);
  });

  it("a partner row the registrant already named is not overwritten by a changed Entries name", () => {
    const named = entry("pair", { partner_name: "Samuel Reid" });
    named.players = [{ ...EMPTY_ROSTER_PLAYER }, { ...EMPTY_ROSTER_PLAYER, full_name: "Sam Reid" }];
    const cart = cartOf(named);
    expect(seedDetailsRows(cart, contact(), [DIV])).toBe(cart);
  });

  it("a Player 1 the registrant typed (someone else) is not claimed as the contact just because the pick was left empty", () => {
    const typed = entry("pair", { registering_self: true, partner_name: "Sam Reid" });
    typed.players = [{ ...EMPTY_ROSTER_PLAYER, full_name: "Jo Park" }, { ...EMPTY_ROSTER_PLAYER }];
    const out = seedDetailsRows(cartOf(typed), contact(), [DIV]);
    expect(out.entries[0]!.self_player_index, "never silently registers 'Jo Park' as Mia").toBeNull();
    expect(names(out.entries[0]!), "the partner still lands on Player 2").toEqual(["Jo Park", "Sam Reid"]);
  });

  it("no partner typed and not registering themselves: nothing to seed (same reference)", () => {
    const cart = cartOf(entry("pair"));
    expect(seedDetailsRows(cart, contact(), [DIV])).toBe(cart);
  });
});

describe("seedDetailsRows: a team starts with its playing captain as Player 1, and nothing blank", () => {
  // A team roster starts empty by design and the captain adds rows with "+ Add player": a BLANK seeded row would trail behind every
  // captain who then adds their own (a blank row blocks Next). Polish wave sign-off V1: a captain who plays IS Player 1, so an empty
  // self-linked roster starts with the contact's own row, named and picked - never blank.
  it("a playing captain's empty roster gets one row: the contact, picked as theirs, with dob/gender when the division asks", () => {
    const division = { ...DIV, requires_dob: true, requires_gender: true };
    const who = contact({ dob: "1994-02-03", gender: "f" });
    const out = seedDetailsRows(cartOf(entry("team", { registering_self: true, team_name: "Riverside" })), who, [division]);
    expect(out.entries[0]!.players).toEqual([{ ...EMPTY_ROSTER_PLAYER, full_name: "Mia Cole", dob: "1994-02-03", gender: "f" }]);
    expect(out.entries[0]!.self_player_index).toBe(0);
    // Second call: nothing left to seed, the same reference.
    expect(seedDetailsRows(out, who, [division])).toBe(out);
    // A division that does not ask carries the name only.
    const plain = seedDetailsRows(cartOf(entry("team", { registering_self: true })), who, [DIV]);
    expect(plain.entries[0]!.players).toEqual([{ ...EMPTY_ROSTER_PLAYER, full_name: "Mia Cole" }]);
  });

  it("a roster the captain already built is left alone, picked or not; a team nobody plays on, or a blank contact, stays empty", () => {
    const built = entry("team", { registering_self: true, self_player_index: 1, team_name: "Riverside" });
    built.players = [{ ...EMPTY_ROSTER_PLAYER, full_name: "Jo" }, { ...EMPTY_ROSTER_PLAYER }];
    const cart = cartOf(built);
    expect(seedDetailsRows(cart, contact(), [DIV])).toBe(cart);
    const notPlaying = cartOf(entry("team", { team_name: "Riverside" }));
    expect(seedDetailsRows(notPlaying, contact(), [DIV])).toBe(notPlaying);
    const blankName = cartOf(entry("team", { registering_self: true }));
    expect(seedDetailsRows(blankName, contact({ name: "  " }), [DIV])).toBe(blankName);
  });
});

describe("seedDetailsRows: the contact's own row follows a Contact rename until the registrant edits it (B2 T10)", () => {
  // Every shape that has a row for the contact. Row 0 is the contact's in each (a pair's pick defaults to Player 1).
  const SHAPES: [string, () => CartEntry][] = [
    ["an individual", () => entry("individual", { registering_self: true })],
    ["a pair's Player 1", () => entry("pair", { registering_self: true, partner_name: "Sam Reid" })],
    ["a playing team captain", () => entry("team", { registering_self: true, team_name: "Riverside" })],
    ["a solo sign-up", () => entry("team", { free_agent: true, players: [{ ...EMPTY_ROSTER_PLAYER }] })],
  ];
  const RENAMED = contact({ name: "Maya Cole" });
  const rowName = (cart: CartState) => cart.entries[0]!.players[0]!.full_name;
  const typeOver = (cart: CartState, full_name: string): CartState => ({
    entries: [{ ...cart.entries[0]!, players: cart.entries[0]!.players.map((p, i) => (i === 0 ? { ...p, full_name } : p)) }],
  });
  let checked = 0;

  it.each(SHAPES)("%s: an untouched row follows the rename, and a second call after that is a no-op", (_label, make) => {
    const seeded = seedDetailsRows(cartOf(make()), contact(), [DIV]);
    expect(rowName(seeded), "premise: the first pass seeded the contact's name").toBe("Mia Cole");
    const followed = seedDetailsRows(seeded, RENAMED, [DIV]);
    expect(rowName(followed)).toBe("Maya Cole");
    expect(seedDetailsRows(followed, RENAMED, [DIV]), "idempotent").toBe(followed);
    checked++;
  });

  it.each(SHAPES)("%s: a row the registrant edited stays through a rename (and the cart is the same reference)", (_label, make) => {
    const edited = typeOver(seedDetailsRows(cartOf(make()), contact(), [DIV]), "Amelia Cole");
    const out = seedDetailsRows(edited, RENAMED, [DIV]);
    expect(rowName(out)).toBe("Amelia Cole");
    expect(out, "nothing to do").toBe(edited);
    checked++;
  });

  it("anti-vacuity: both directions ran for every shape", () => {
    expect(checked).toBe(SHAPES.length * 2);
  });

  it("a pair's partner row and the self pick do not move with the rename", () => {
    const seeded = seedDetailsRows(cartOf(entry("pair", { registering_self: true, partner_name: "Sam Reid" })), contact(), [DIV]);
    const out = seedDetailsRows(seeded, RENAMED, [DIV]).entries[0]!;
    expect(names(out)).toEqual(["Maya Cole", "Sam Reid"]);
    expect(out.self_player_index).toBe(0);
  });

  it("typing the seeded name back by hand is indistinguishable from the seed, so the row follows again", () => {
    const seeded = seedDetailsRows(cartOf(entry("individual", { registering_self: true })), contact(), [DIV]);
    const away = typeOver(seeded, "Amelia Cole");
    const back = typeOver(away, "Mia Cole");
    expect(rowName(seedDetailsRows(back, RENAMED, [DIV]))).toBe("Maya Cole");
  });

  it("a draft saved before the seed was recorded (no `seeded_from`) follows only if its row already carries the contact's name", () => {
    const legacy = (full_name: string) =>
      cartOf(entry("individual", { registering_self: true, players: [{ ...EMPTY_ROSTER_PLAYER, full_name }] }));
    // Same name as Contact: the first pass recognises it, the rename then follows.
    const same = seedDetailsRows(legacy("Mia Cole"), contact(), [DIV]);
    expect(rowName(seedDetailsRows(same, RENAMED, [DIV]))).toBe("Maya Cole");
    // A different name was typed by the registrant: never claimed, never followed.
    const other = legacy("Jo Park");
    const afterFirst = seedDetailsRows(other, contact(), [DIV]);
    expect(afterFirst, "nothing recognised, nothing written").toBe(other);
    expect(rowName(seedDetailsRows(afterFirst, RENAMED, [DIV]))).toBe("Jo Park");
  });

  it("a team roster the captain built is theirs: the seed neither records nor follows it, even a row that equals the contact's name", () => {
    const built = entry("team", { registering_self: true, self_player_index: 0, team_name: "Riverside" });
    built.players = [{ ...EMPTY_ROSTER_PLAYER, full_name: "Mia Cole" }, { ...EMPTY_ROSTER_PLAYER, full_name: "Jo" }];
    const cart = cartOf(built);
    expect(seedDetailsRows(cart, contact(), [DIV]), "the row equals Contact today, and still nothing is recorded: the same reference").toBe(cart);
    expect(seedDetailsRows(cart, RENAMED, [DIV]), "so a rename finds nothing to follow").toBe(cart);
  });

  it("a captain who blanked their own seeded row is not re-filled by a rename (a blank row is theirs to retype)", () => {
    const blanked = typeOver(seedDetailsRows(cartOf(entry("team", { registering_self: true, team_name: "Riverside" })), contact(), [DIV]), "");
    const out = seedDetailsRows(blanked, RENAMED, [DIV]);
    expect(out).toBe(blanked);
    expect(rowName(out)).toBe("");
  });

  it.each(SHAPES)("%s: a blank contact name never blanks or overwrites a seeded row", (_label, make) => {
    const seeded = seedDetailsRows(cartOf(make()), contact(), [DIV]);
    const out = seedDetailsRows(seeded, contact({ name: "   " }), [DIV]);
    expect(out).toBe(seeded);
    expect(rowName(out)).toBe("Mia Cole");
  });

  it("dob and gender follow a change in Contact only while the row still holds what Contact gave it, and only when the division asks", () => {
    const asks = { ...DIV, requires_dob: true, requires_gender: true };
    const first = contact({ dob: "1990-04-02", gender: "f" });
    const next = contact({ dob: "1991-05-03", gender: "m" });
    const seeded = seedDetailsRows(cartOf(entry("individual", { registering_self: true })), first, [asks]);
    expect(seeded.entries[0]!.players[0], "premise").toMatchObject({ dob: "1990-04-02", gender: "f" });
    expect(seedDetailsRows(seeded, next, [asks]).entries[0]!.players[0], "untouched: both follow").toMatchObject({ dob: "1991-05-03", gender: "m" });
    // The registrant changed the row's dob (not the gender): the dob is theirs, the gender still follows.
    const typed: CartState = { entries: [{ ...seeded.entries[0]!, players: [{ ...seeded.entries[0]!.players[0]!, dob: "1985-01-01" }] }] };
    expect(seedDetailsRows(typed, next, [asks]).entries[0]!.players[0]).toMatchObject({ dob: "1985-01-01", gender: "m" });
    // A division that does not ask never gets a dob or gender, however Contact changes.
    const silent = seedDetailsRows(cartOf(entry("individual", { registering_self: true })), first, [DIV]);
    expect(seedDetailsRows(silent, next, [DIV]).entries[0]!.players[0]).toMatchObject({ dob: null, gender: null });
  });

  it("the record is client-only state: a seeded entry carries it, and an entry that was never self-linked carries none", () => {
    const seeded = seedDetailsRows(cartOf(entry("individual", { registering_self: true })), contact(), [DIV]);
    expect(seeded.entries[0]!.seeded_from).toMatchObject({ name: "Mia Cole" });
    const plain = cartOf(entry("individual"));
    expect(seedDetailsRows(plain, contact(), [DIV]).entries[0]!.seeded_from).toBeUndefined();
  });
});

describe("seedDetailsRows: the empty and the exempt cases", () => {
  it("an empty cart is the same reference", () => {
    expect(seedDetailsRows(EMPTY_CART, contact(), [DIV])).toBe(EMPTY_CART);
  });

  // Polish wave P5 (H-1): a solo sign-up is the registrant looking for a team, and its Details step now collects that player (Assign
  // places this row). It starts from the contact like any self row: name always, dob/gender when the division asks.
  it("a solo (free agent) entry's one row starts from the contact; a solo with no row yet (an older cart) gets one", () => {
    const division = { ...DIV, division_id: "div-1", requires_dob: true, requires_gender: true };
    const who = contact({ dob: "1994-02-03", gender: "f" });
    const seededRow = { ...EMPTY_ROSTER_PLAYER, full_name: "Mia Cole", dob: "1994-02-03", gender: "f" as const };
    const cases = [
      entry("team", { free_agent: true, players: [{ ...EMPTY_ROSTER_PLAYER }] }),
      entry("team", { free_agent: true, players: [] }),
    ];
    for (const solo of cases) {
      const next = seedDetailsRows(cartOf(solo), who, [division]);
      expect(next.entries[0]!.players).toEqual([seededRow]);
      // Second call: nothing left to seed, the same reference.
      expect(seedDetailsRows(next, who, [division])).toBe(next);
    }
    expect(cases.length, "both solo shapes checked").toBe(2);
  });

  it("a solo row the registrant already filled is never overwritten (blank-only)", () => {
    const typed = { ...EMPTY_ROSTER_PLAYER, full_name: "Kid Cole" };
    const cart = cartOf(entry("team", { free_agent: true, players: [typed] }));
    expect(seedDetailsRows(cart, contact(), [DIV])).toBe(cart);
  });

  it("each entry is seeded on its own: one cart of a self individual, a pair and a team (counted, never vacuous)", () => {
    const cart = cartOf(
      { ...entry("individual", { registering_self: true }), id: "a" },
      { ...entry("pair", { partner_name: "Sam Reid" }), id: "b" },
      { ...entry("team", { registering_self: true, team_name: "Riverside" }), id: "c" },
    );
    const out = seedDetailsRows(cart, contact(), [DIV]);
    const seeded = out.entries.map(names);
    expect(seeded).toEqual([["Mia Cole"], ["", "Sam Reid"], ["Mia Cole"]]);
    expect(seeded.flat().filter(Boolean).length, "premise: three names were written (the contact twice, the partner once)").toBe(3);
  });

  it("the input cart is never mutated", () => {
    const cart = cartOf(entry("individual", { registering_self: true }));
    const before = JSON.stringify(cart);
    seedDetailsRows(cart, contact(), [DIV]);
    expect(JSON.stringify(cart)).toBe(before);
  });
});
