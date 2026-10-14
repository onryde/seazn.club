// T17B fix 2, D19: the room's sound switch, remembered per device in localStorage. Every storage touch is inside
// try/catch — a blocked origin throws on the accessor itself, private modes and full quotas throw on the calls — and
// the page keeps the choice in memory, so the switch works with no storage at all (it is then forgotten on reload).
// Default ON: the room is the players' page. (The arbiter's view, components/v2/arbiter-panel.tsx, draws no board
// and plays no move sounds — OFF by construction.)

export const SOUND_PREF_KEY = "seazn:match-room:sound";

export type SoundPrefStore = {
  get(): boolean;
  set(on: boolean): void;
  subscribe(onChange: () => void): () => void;
  /** What a server render (and hydration) assumes: the default. */
  server(): boolean;
};

export function soundPrefStore(storage: () => Storage | null, fallback = true): SoundPrefStore {
  let value: boolean | null = null;
  const listeners = new Set<() => void>();
  const read = (): boolean => {
    try {
      const raw = storage()?.getItem(SOUND_PREF_KEY);
      return raw === "on" ? true : raw === "off" ? false : fallback;
    } catch {
      return fallback;
    }
  };
  return {
    get() {
      if (value === null) value = read();
      return value;
    },
    set(on) {
      value = on;
      try {
        storage()?.setItem(SOUND_PREF_KEY, on ? "on" : "off");
      } catch {
        // Storage refused: the page keeps the choice.
      }
      for (const l of [...listeners]) l();
    },
    subscribe(onChange) {
      listeners.add(onChange);
      // Another tab on the same device changed it.
      const onStorage = (e: StorageEvent) => {
        if (e.key !== SOUND_PREF_KEY) return;
        value = null;
        onChange();
      };
      const w = typeof window === "undefined" ? null : window;
      w?.addEventListener("storage", onStorage);
      return () => {
        listeners.delete(onChange);
        w?.removeEventListener("storage", onStorage);
      };
    },
    server: () => fallback,
  };
}

const browserStorage = (): Storage | null => (typeof window === "undefined" ? null : window.localStorage);

/** The page's one switch. */
export const ROOM_SOUND_PREF: SoundPrefStore = soundPrefStore(browserStorage);
