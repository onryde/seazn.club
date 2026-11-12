// Polish wave P4 (walkthrough W1, W3): the registrant typed their own name on step 1 and ticked "I'm registering myself", then met an
// empty "Player 1" on the Details step and typed the same name again; a pair partner typed on Entries met an empty "Player 2". These are
// the rules for what Details starts with, from what the earlier steps already collected. Literals are the walkthrough's own.
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

  it("a second call changes nothing, and a name the registrant typed over the seed is never overwritten", () => {
    const first = seedDetailsRows(cartOf(entry("individual", { registering_self: true })), contact(), [DIV]);
    expect(seedDetailsRows(first, contact(), [DIV]), "idempotent: the same reference").toBe(first);
    const edited: CartState = {
      entries: [{ ...first.entries[0]!, players: [{ ...first.entries[0]!.players[0]!, full_name: "Amelia Cole" }] }],
    };
    expect(names(seedDetailsRows(edited, contact(), [DIV]).entries[0]!), "the typed name survives a re-entry into Details").toEqual(["Amelia Cole"]);
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

describe("seedDetailsRows: a team is never seeded", () => {
  // A team roster starts empty by design and the captain adds rows with "+ Add player": a seeded row would leave a trailing blank row
  // (which blocks Next) for every captain who then adds their own, which is every captain.
  it("a captain who plays still starts with an empty roster, picked or not", () => {
    const empty = cartOf(entry("team", { registering_self: true, team_name: "Riverside" }));
    expect(seedDetailsRows(empty, contact(), [DIV])).toBe(empty);
    const built = entry("team", { registering_self: true, self_player_index: 1, team_name: "Riverside" });
    built.players = [{ ...EMPTY_ROSTER_PLAYER, full_name: "Jo" }, { ...EMPTY_ROSTER_PLAYER }];
    const cart = cartOf(built);
    expect(seedDetailsRows(cart, contact(), [DIV])).toBe(cart);
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
    expect(seeded).toEqual([["Mia Cole"], ["", "Sam Reid"], []]);
    expect(seeded.flat().filter(Boolean).length, "premise: two names were written (the contact once, the partner once)").toBe(2);
  });

  it("the input cart is never mutated", () => {
    const cart = cartOf(entry("individual", { registering_self: true }));
    const before = JSON.stringify(cart);
    seedDetailsRows(cart, contact(), [DIV]);
    expect(JSON.stringify(cart)).toBe(before);
  });
});
