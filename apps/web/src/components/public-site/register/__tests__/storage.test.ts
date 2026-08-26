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
  cart: { ...EMPTY_CART, entries: [{ id: "e1", division_id: "d1", entrant_kind: "individual", team_name: null, partner_name: null, free_agent: false }] },
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
