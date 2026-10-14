// The Recording band's per-device memory (ESLint L3). The stored band used to
// be copied out of `localStorage` into state by a mount effect; it is now read
// through `useLocalStorageItem` (server snapshot "nothing stored") and a pick is
// held per fixture key, in `usePadBand` — the hook PadHostV3 hands its own
// RecordingChip's `activeBand` from. The sequence a scorer walks:
//   server/hydration render → the sport default (the I-2 hydration rule);
//   after hydration → the stored band; a pick → shown and remembered;
//   another fixture → re-seeds from THAT fixture's key; a junk stored value →
//   the default; a storage that throws → the pad still mounts and still
//   changes band. Expected bands come from `defaultBandFor` over football's
//   own `padSpec(cfg).fidelity` declaration and the stored strings — never
//   from the hook. One sport: the rules here are sport-agnostic storage
//   rules; `defaultBandFor` across every sport is pad-host.test.ts's sweep.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { FidelityBand } from "@seazn/engine/sport";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { football } from "@seazn/engine/sports/football";
import { renderIsland, propsOf } from "@/components/__tests__/_hook-harness";
import { bandStorageKey, defaultBandFor, usePadBand } from "../pad-host";
import { footballCfg } from "./_football-fold";

let store: Map<string, string>;
let throws = false;
beforeEach(() => {
  store = new Map();
  throws = false;
  vi.stubGlobal("window", {
    get localStorage() {
      if (throws) throw new Error("SecurityError");
      return {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      };
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const fidelity = football.padSpec!(footballCfg()).fidelity;
const DEFAULT = defaultBandFor(fidelity);

/** Drives the host's own hook; renders the band it hands the RecordingChip. */
function Probe({ fixtureId }: { fixtureId: string }) {
  const [band, onBandChange] = usePadBand(fixtureId, fidelity);
  return <i data-band={band} onClick={onBandChange as unknown as () => void} />;
}
const bandOf = (island: { tree: () => ReactElement[] }) => {
  const el = island.tree().find((e) => e.type === "i");
  expect(el, "the probe rendered").toBeDefined();
  return propsOf(el!)["data-band"] as FidelityBand;
};
const pick = (island: { tree: () => ReactElement[] }, band: FidelityBand) =>
  (propsOf(island.tree().find((e) => e.type === "i")!).onClick as unknown as (b: FidelityBand) => void)(band);

describe("usePadBand — the Recording band remembered per device", () => {
  it("anti-vacuity: football declares a band map whose default is above the bands picked below", () => {
    expect(Object.keys(fidelity).length).toBeGreaterThan(0);
    expect(DEFAULT).toBeGreaterThan(1);
  });

  it("PadHostV3 takes its band from this hook (the seam, read in the source)", () => {
    // The harness cannot mount a whole PadHostV3 (its pipeline never converges
    // under the node harness, old code and new alike), so the wiring is pinned
    // here and driven for real by e2e/scoring-free.spec.ts's hydration test.
    const src = readFileSync(resolve(__dirname, "../pad-host.tsx"), "utf8");
    expect(src).toContain("const [band, onBandChange] = usePadBand(props.fixtureId, spec.fidelity);");
    expect(src).toMatch(/<RecordingChip\s+activeBand=\{band\}\s+onBandChange=\{onBandChange\}/);
  });

  it("server render is the default even with a band stored; after hydration the stored band", () => {
    store.set(bandStorageKey("fx-1"), "1");
    expect(bandOf(renderIsland(Probe, { fixtureId: "fx-1" })), "server snapshot").toBe(DEFAULT);
    expect(bandOf(renderIsland(Probe, { fixtureId: "fx-1" }, undefined, { hydrate: true }))).toBe(1);
  });

  it("a pick shows and is remembered; another fixture re-seeds from its own key; back again keeps the pick", () => {
    store.set(bandStorageKey("fx-2"), "0");
    const island = renderIsland(Probe, { fixtureId: "fx-1" }, undefined, { hydrate: true });
    expect(bandOf(island), "nothing stored for fx-1").toBe(DEFAULT);

    pick(island, 1);
    expect(bandOf(island)).toBe(1);
    expect(store.get(bandStorageKey("fx-1"))).toBe("1");

    island.rerender({ fixtureId: "fx-2" });
    expect(bandOf(island), "fx-2's own stored band").toBe(0);
    island.rerender({ fixtureId: "fx-1" });
    expect(bandOf(island)).toBe(1);
  });

  it("a junk stored value reads as the default", () => {
    store.set(bandStorageKey("fx-1"), "every-detail");
    expect(bandOf(renderIsland(Probe, { fixtureId: "fx-1" }, undefined, { hydrate: true }))).toBe(DEFAULT);
  });

  it("a storage that throws: mounts at the default and a pick still changes the band", () => {
    throws = true;
    const island = renderIsland(Probe, { fixtureId: "fx-1" }, undefined, { hydrate: true });
    expect(bandOf(island)).toBe(DEFAULT);
    pick(island, 1);
    expect(bandOf(island)).toBe(1);
  });
});
