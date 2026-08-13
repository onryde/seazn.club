// pad-context.tsx (S10/#419 W8): resolves the PINNED module (never `latest`)
// and carries it + auth mode + resolved cfg + fidelity/entitlements/
// recorder-names in one context. Not named in the brief's own __tests__
// list (transport/use-pad-pipeline/use-fixture-stream only), but the
// acceptance criteria explicitly requires a pinned-version regression test,
// provable only against THIS file's own resolution call — added as the
// natural pairing to pad-context.tsx, not a scope expansion.
//
// The Provider's constructed VALUE is inspected via the rendered element
// tree (`walk`/`propsOf`) rather than a live Provider->Consumer subscription
// — this repo's node-only `_hook-harness` has no real context propagation
// (`useContext` always returns the context's DEFAULT value; see its own
// header comment), so that is the one thing this suite cannot exercise —
// left to the real-browser Playwright pass per the S10 decision log's own
// documented testing-topology ruling.
import { beforeAll, describe, expect, it } from "vitest";
import { EngineError } from "@seazn/engine/core";
import { registry } from "@seazn/engine/sport";
import { generic } from "@seazn/engine/sports/generic";
import { propsOf, renderIsland, walk } from "@/components/__tests__/_hook-harness";
import type { PadAuthMode } from "../transport";
import { PadContext, PadContextProvider, usePadContext, type PadContextValue } from "../pad-context";

// A second, OLDER registration of a REAL sport key, alongside its real
// 1.0.0 — simulates "a division pinned to an older module version". All 11
// real modules ship at exactly 1.0.0 (S1 ruling — no version bumps, no prod
// data), so proving version-DISCRIMINATION needs a manufactured second
// version — same technique module-client.test.ts's own MODULE_DUPLICATE-
// tolerance test uses for the sibling concern.
const OLDER_GENERIC = { ...generic, version: "0.5.0" };
beforeAll(() => {
  try {
    registry.register(OLDER_GENERIC);
  } catch (err) {
    if (!EngineError.is(err, "MODULE_DUPLICATE")) throw err;
  }
});

function providerValue(props: Parameters<typeof PadContextProvider>[0]): PadContextValue {
  const island = renderIsland(PadContextProvider, props, (node) => walk(node));
  const [providerEl] = island.tree();
  expect(providerEl!.type, "expected the Provider element as the tree root").toBe(PadContext.Provider);
  return propsOf(providerEl!).value as PadContextValue;
}

const SESSION: PadAuthMode = { kind: "session" };

describe("PadContextProvider", () => {
  it("constructs the context value with the resolved module and every field passed through unchanged", () => {
    const value = providerValue({
      fixtureId: "fx-1",
      sportKey: "football",
      moduleVersion: "1.0.0",
      cfg: { halfMinutes: 45 },
      auth: SESSION,
      fidelityBand: 1,
      entitlements: { "stats.player": true },
      recorderNames: { u1: "Alex" },
      children: null,
    });
    expect(value.fixtureId).toBe("fx-1");
    expect(value.sportKey).toBe("football");
    expect(value.moduleVersion).toBe("1.0.0");
    expect(value.module.key).toBe("football");
    expect(value.module.version).toBe("1.0.0");
    expect(value.cfg).toEqual({ halfMinutes: 45 });
    expect(value.auth).toBe(SESSION);
    expect(value.fidelityBand).toBe(1);
    expect(value.entitlements).toEqual({ "stats.player": true });
    expect(value.recorderNames).toEqual({ u1: "Alex" });
  });

  it("defaults entitlements and recorderNames to empty objects when omitted", () => {
    const value = providerValue({
      fixtureId: "fx-1",
      sportKey: "football",
      moduleVersion: "1.0.0",
      cfg: {},
      auth: SESSION,
      fidelityBand: 0,
      children: null,
    });
    expect(value.entitlements).toEqual({});
    expect(value.recorderNames).toEqual({});
  });

  it("device_link auth mode passes through, carrying its token", () => {
    const auth: PadAuthMode = { kind: "device_link", token: "dl_xyz" };
    const value = providerValue({
      fixtureId: "fx-1",
      sportKey: "football",
      moduleVersion: "1.0.0",
      cfg: {},
      auth,
      fidelityBand: 0,
      children: null,
    });
    expect(value.auth).toEqual({ kind: "device_link", token: "dl_xyz" });
  });

  it("MUTATION TARGET / pinned-version regression: an older pinned module_version resolves THAT module, never latest", () => {
    const value = providerValue({
      fixtureId: "fx-1",
      sportKey: "generic",
      moduleVersion: "0.5.0",
      cfg: {},
      auth: SESSION,
      fidelityBand: 0,
      children: null,
    });
    expect(value.module.version).toBe("0.5.0");
    expect(value.module).toBe(OLDER_GENERIC);
    expect(value.module).not.toBe(generic); // the REAL 1.0.0 object
  });

  it("resolves the real 1.0.0 pin correctly too (the two-version registration above did not shadow it)", () => {
    const value = providerValue({
      fixtureId: "fx-1",
      sportKey: "generic",
      moduleVersion: "1.0.0",
      cfg: {},
      auth: SESSION,
      fidelityBand: 0,
      children: null,
    });
    expect(value.module).toBe(generic);
  });

  it("throws for an unregistered (sportKey, moduleVersion) pin rather than silently substituting", () => {
    expect(() =>
      providerValue({
        fixtureId: "fx-1",
        sportKey: "generic",
        moduleVersion: "9.9.9",
        cfg: {},
        auth: SESSION,
        fidelityBand: 0,
        children: null,
      }),
    ).toThrow();
  });
});

describe("usePadContext", () => {
  it("throws outside a PadContextProvider", () => {
    function Probe() {
      usePadContext();
      return null;
    }
    expect(() => renderIsland(Probe, {})).toThrow("usePadContext must be used within a PadContextProvider");
  });
});
