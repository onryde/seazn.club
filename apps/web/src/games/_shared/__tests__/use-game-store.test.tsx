// useGameStore — SSR-guarded localStorage state, same posture as
// chess-quest's lib/progress.tsx (loadBlob): try/catch around JSON.parse,
// discard-and-restart on any corrupt or malformed value, safe to call when
// window/localStorage doesn't exist.
//
// This vitest environment runs under Node (no jsdom, no browser globals —
// see chess-quest's Board.test.tsx / useSfx.test.ts for the same fact), so
// the bulk of the coverage here goes through the pure load/save helpers
// (mirroring how progress.test.ts tests createProgressState directly rather
// than through a live render) plus one renderToStaticMarkup smoke test that
// exercises the real hook end to end under genuinely-no-`window` conditions
// — which is exactly the SSR case the guard exists for.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { loadStoredValue, saveStoredValue, useGameStore } from "../use-game-store";

// Minimal in-memory Storage, same shape as progress.test.ts's fakeStorage().
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    key: (i) => Array.from(map.keys())[i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, String(v)),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadStoredValue", () => {
  it("returns initial when there is no storage at all (SSR guard)", () => {
    expect(loadStoredValue(undefined, "seazn-games:x:v1", { n: 0 })).toEqual({ n: 0 });
  });

  it("returns initial when the key is absent", () => {
    const storage = fakeStorage();
    expect(loadStoredValue(storage, "seazn-games:x:v1", { n: 0 })).toEqual({ n: 0 });
  });

  it("round-trips a value saved through saveStoredValue", () => {
    const storage = fakeStorage();
    saveStoredValue(storage, "seazn-games:x:v1", { n: 7 });
    expect(loadStoredValue(storage, "seazn-games:x:v1", { n: 0 })).toEqual({ n: 7 });
  });

  it("recovers from a corrupt (non-JSON) blob, discards it, and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const storage = fakeStorage();
    storage.setItem("seazn-games:x:v1", "{not json");
    expect(loadStoredValue(storage, "seazn-games:x:v1", { n: 0 })).toEqual({ n: 0 });
    expect(warn).toHaveBeenCalled();
  });

  it("applies migrate to the parsed raw value", () => {
    const storage = fakeStorage();
    storage.setItem("seazn-games:x:v1", JSON.stringify({ legacyCount: 3 }));
    const migrate = (raw: unknown) => {
      const r = raw as { legacyCount?: number };
      return { n: r.legacyCount ?? 0 };
    };
    expect(loadStoredValue(storage, "seazn-games:x:v1", { n: 0 }, migrate)).toEqual({ n: 3 });
  });

  it("falls back to initial and warns when migrate itself throws", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const storage = fakeStorage();
    storage.setItem("seazn-games:x:v1", JSON.stringify({ anything: true }));
    const migrate = (): { n: number } => {
      throw new Error("bad shape");
    };
    expect(loadStoredValue(storage, "seazn-games:x:v1", { n: 0 }, migrate)).toEqual({ n: 0 });
    expect(warn).toHaveBeenCalled();
  });

  it("does not call migrate at all when there is nothing stored", () => {
    const storage = fakeStorage();
    const migrate = vi.fn((raw: unknown) => raw as { n: number });
    loadStoredValue(storage, "seazn-games:x:v1", { n: 0 }, migrate);
    expect(migrate).not.toHaveBeenCalled();
  });
});

describe("saveStoredValue", () => {
  it("no-ops without throwing when there is no storage (SSR guard)", () => {
    expect(() => saveStoredValue(undefined, "seazn-games:x:v1", { n: 1 })).not.toThrow();
  });

  it("swallows a storage write failure (private mode / quota) without throwing", () => {
    const storage = fakeStorage();
    storage.setItem = () => {
      throw new Error("quota exceeded");
    };
    expect(() => saveStoredValue(storage, "seazn-games:x:v1", { n: 1 })).not.toThrow();
  });
});

describe("useGameStore (rendered through react-dom/server — no jsdom in this workspace)", () => {
  function Probe({ onValue }: { onValue(value: unknown, set: unknown): void }) {
    const [value, set] = useGameStore("seazn-games:probe:v1", { n: 0 });
    onValue(value, set);
    return <div>{(value as { n: number }).n}</div>;
  }

  it("returns [initial, setter] when window doesn't exist (the real SSR case)", () => {
    expect(typeof window).toBe("undefined");
    let seenValue: unknown;
    let seenSetter: unknown;
    const html = renderToStaticMarkup(
      <Probe
        onValue={(value, set) => {
          seenValue = value;
          seenSetter = set;
        }}
      />,
    );
    expect(seenValue).toEqual({ n: 0 });
    expect(typeof seenSetter).toBe("function");
    expect(html).toContain("<div>0</div>");
  });
});
