// T17B fix 2, D19: the room's sound switch is remembered per device (localStorage), read and written inside try/catch,
// and still works when storage is unavailable — the page keeps the choice for as long as it is open.
import { describe, expect, it, vi } from "vitest";
import { SOUND_PREF_KEY, soundPrefStore } from "../sound-pref";

class MemoryStorage {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
}
const as = (s: MemoryStorage) => s as unknown as Storage;

describe("the sound switch's memory (D19)", () => {
  it("the empty case first: nothing stored ⇒ ON for a player, and the server's render agrees", () => {
    const store = soundPrefStore(() => as(new MemoryStorage()));
    expect(store.get()).toBe(true);
    expect(store.server()).toBe(true);
  });

  it("a choice is written, and a fresh page on the same device reads it back — both ways (counted)", () => {
    const device = new MemoryStorage();
    let checked = 0;
    for (const on of [false, true, false]) {
      soundPrefStore(() => as(device)).set(on);
      expect(device.map.get(SOUND_PREF_KEY)).toBe(on ? "on" : "off");
      expect(soundPrefStore(() => as(device)).get(), `a reload after choosing ${on ? "on" : "off"}`).toBe(on);
      checked += 1;
    }
    expect(checked).toBe(3);
  });

  it("anything else on file is the default, not a crash", () => {
    let checked = 0;
    for (const raw of ["", "maybe", "false", "0", "OFF"]) {
      const device = new MemoryStorage();
      device.map.set(SOUND_PREF_KEY, raw);
      expect(soundPrefStore(() => as(device)).get(), JSON.stringify(raw)).toBe(true);
      checked += 1;
    }
    expect(checked).toBe(5);
  });

  it("storage unavailable — the getter throws, getItem throws, setItem throws, or there is none: the switch still works on the page (counted)", () => {
    const blocked: [string, () => Storage | null][] = [
      ["no storage at all", () => null],
      [
        "the accessor throws (a blocked origin)",
        () => {
          throw new DOMException("denied", "SecurityError");
        },
      ],
      [
        "getItem and setItem throw (private mode, quota)",
        () =>
          ({
            getItem() {
              throw new DOMException("denied", "SecurityError");
            },
            setItem() {
              throw new DOMException("full", "QuotaExceededError");
            },
          }) as unknown as Storage,
      ],
    ];
    let checked = 0;
    for (const [name, storage] of blocked) {
      const store = soundPrefStore(storage);
      expect(store.get(), name).toBe(true);
      expect(() => store.set(false), name).not.toThrow();
      expect(store.get(), `${name}: the page keeps the choice`).toBe(false);
      store.set(true);
      expect(store.get(), name).toBe(true);
      checked += 1;
    }
    expect(checked).toBe(blocked.length);
  });

  it("a change tells every subscriber; an unsubscribed one hears nothing more", () => {
    const store = soundPrefStore(() => as(new MemoryStorage()));
    const heard = vi.fn();
    const off = store.subscribe(heard);
    store.set(false);
    expect(heard).toHaveBeenCalledTimes(1);
    off();
    store.set(true);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("another tab's change (the storage event) is read afresh", () => {
    const device = new MemoryStorage();
    const listeners: ((e: { key: string | null }) => void)[] = [];
    vi.stubGlobal("window", {
      addEventListener: (type: string, l: (e: { key: string | null }) => void) => type === "storage" && listeners.push(l),
      removeEventListener: () => {},
    });
    try {
      const store = soundPrefStore(() => as(device));
      expect(store.get()).toBe(true);
      const heard = vi.fn();
      store.subscribe(heard);
      expect(listeners, "premise: subscribed to the storage event").toHaveLength(1);
      device.map.set(SOUND_PREF_KEY, "off");
      listeners[0]!({ key: "some-other-key" });
      expect(heard, "another key is not ours").not.toHaveBeenCalled();
      listeners[0]!({ key: SOUND_PREF_KEY });
      expect(heard).toHaveBeenCalledTimes(1);
      expect(store.get()).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
