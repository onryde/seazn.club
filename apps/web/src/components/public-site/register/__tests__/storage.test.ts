// RS006 chassis — sessionStorage persistence (pure, no DOM: storage is
// injected, same fake-storage pattern as lib/analytics-identity.test.ts).
// Mirrors analytics-identity.ts's guarded-storage convention: never throws,
// drops a malformed entry instead of propagating the parse error.
import { describe, expect, it } from "vitest";
import {
  clearRegisterState,
  loadRegisterState,
  REGISTER_STATE_VERSION,
  saveRegisterState,
  type PersistedRegisterState,
} from "../storage";
import { EMPTY_CART, EMPTY_CONTACT } from "../types";

class MapStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

const SNAPSHOT: PersistedRegisterState = {
  version: REGISTER_STATE_VERSION,
  contact: { ...EMPTY_CONTACT, name: "Alex Test", email: "alex@example.com" },
  imPlaying: true,
  cart: {
    ...EMPTY_CART,
    entries: [
      {
        id: "e1",
        division_id: "d1",
        entrant_kind: "individual",
        team_name: null,
        partner_name: null,
        free_agent: false,
        players: [],
        answers: {},
        registering_self: false,
        self_player_index: null,
      },
    ],
  },
  stepIndex: 1,
};

describe("save/load round trip", () => {
  it("loads back exactly what was saved, scoped by org+competition", () => {
    const storage = new MapStorage();
    saveRegisterState("riverside", "summer-smash", SNAPSHOT, storage);
    expect(loadRegisterState("riverside", "summer-smash", storage)).toEqual(SNAPSHOT);
  });

  it("a different competition (or org) never sees another's saved state", () => {
    const storage = new MapStorage();
    saveRegisterState("riverside", "summer-smash", SNAPSHOT, storage);
    expect(loadRegisterState("riverside", "winter-cup", storage)).toBeNull();
    expect(loadRegisterState("other-org", "summer-smash", storage)).toBeNull();
  });

  it("returns null when nothing was ever saved", () => {
    const storage = new MapStorage();
    expect(loadRegisterState("riverside", "summer-smash", storage)).toBeNull();
  });
});

describe("clearRegisterState", () => {
  it("removes exactly the scoped entry", () => {
    const storage = new MapStorage();
    saveRegisterState("riverside", "summer-smash", SNAPSHOT, storage);
    clearRegisterState("riverside", "summer-smash", storage);
    expect(loadRegisterState("riverside", "summer-smash", storage)).toBeNull();
  });
});

describe("guarded against a malformed or stale entry — never throws", () => {
  it("drops (rather than returns) an entry that isn't valid JSON", () => {
    const storage = new MapStorage();
    storage.setItem("seazn_register_riverside_summer-smash", "{not json");
    expect(loadRegisterState("riverside", "summer-smash", storage)).toBeNull();
  });

  it("drops an entry from a future/incompatible version rather than misinterpreting it", () => {
    const storage = new MapStorage();
    storage.setItem(
      "seazn_register_riverside_summer-smash",
      JSON.stringify({ ...SNAPSHOT, version: 999 }),
    );
    expect(loadRegisterState("riverside", "summer-smash", storage)).toBeNull();
  });

  it("drops a v1 (pre-step-3) snapshot whose CartEntry rows lack players/answers, instead of handing the stepper a shape it will crash reading — REGISTER_STATE_VERSION must be bumped past any release that persisted the OLD CartEntry shape", () => {
    const storage = new MapStorage();
    // The exact shape RS006's chassis+WHO+ENTRIES wave persisted, BEFORE
    // step 3 added players/answers to CartEntry (register-stepper.tsx's own
    // saveRegisterState effect ran on every keystroke, so any browser that
    // ever loaded that build has one of these sitting in sessionStorage).
    const preStep3Cart = {
      entries: [
        { id: "e1", division_id: "d1", entrant_kind: "individual", team_name: null, partner_name: null, free_agent: false },
      ],
      selfEntryId: null,
      selfPlayerIndex: null,
    };
    storage.setItem(
      "seazn_register_riverside_summer-smash",
      JSON.stringify({ version: 1, contact: SNAPSHOT.contact, imPlaying: false, cart: preStep3Cart, stepIndex: 1 }),
    );
    expect(loadRegisterState("riverside", "summer-smash", storage)).toBeNull();
  });

  it("drops a v2 (pre-self-rework) snapshot whose self-link lived cart-level (selfEntryId/selfPlayerIndex), instead of silently losing every restored self-link — REGISTER_STATE_VERSION must be bumped past any release that persisted the OLD CartState shape", () => {
    const storage = new MapStorage();
    // The exact shape RS006's step-3 (DETAILS) wave persisted, BEFORE the
    // self-link fix moved registering_self/self_player_index onto EACH
    // CartEntry. entry.registering_self is simply ABSENT here (not false) —
    // reading it against this snapshot without the version bump would
    // silently evaluate to undefined (falsy), quietly dropping every
    // restored self-link rather than crashing OR degrading loudly.
    const v2Cart = {
      entries: [
        {
          id: "e1",
          division_id: "d1",
          entrant_kind: "individual",
          team_name: null,
          partner_name: null,
          free_agent: false,
          players: [],
          answers: {},
        },
      ],
      selfEntryId: "e1",
      selfPlayerIndex: 0,
    };
    storage.setItem(
      "seazn_register_riverside_summer-smash",
      JSON.stringify({ version: 2, contact: SNAPSHOT.contact, imPlaying: true, cart: v2Cart, stepIndex: 1 }),
    );
    expect(loadRegisterState("riverside", "summer-smash", storage)).toBeNull();
  });
});

describe("no storage available (SSR / privacy mode) — degrades to a no-op, never throws", () => {
  it("save is a silent no-op without storage", () => {
    expect(() => saveRegisterState("riverside", "summer-smash", SNAPSHOT, null)).not.toThrow();
  });

  it("load returns null without storage", () => {
    expect(loadRegisterState("riverside", "summer-smash", null)).toBeNull();
  });

  it("clear is a silent no-op without storage", () => {
    expect(() => clearRegisterState("riverside", "summer-smash", null)).not.toThrow();
  });
});
