// PR #971 review I1: the gate both live Fly legs pass before they may create a Machine (_live-fly-gate.ts). Pure — no
// token, no network. The expected refusals come from the gate's contract: the retired name is config.ts's own
// declaration (FLY_RELAY_APP_RETIRED_DEFAULT), never a copy typed here.
import { describe, expect, it, vi } from "vitest";
import { FLY_RELAY_APP_RETIRED_DEFAULT } from "../config";
import { liveFlyGate } from "./_live-fly-gate";

const LIVE = { RELAY_LIVE_FLY: "1" } as const;

describe("liveFlyGate — a live Fly leg names its app explicitly, never the retired one", () => {
  it("without RELAY_LIVE_FLY=1 it is disabled and reads NOTHING else — not the app, not the token", () => {
    let checked = 0;
    for (const flag of [undefined, "", "0", "true", "yes"]) {
      const readToken = vi.fn(() => "tok");
      const g = liveFlyGate({ RELAY_LIVE_FLY: flag, FLY_RELAY_APP: FLY_RELAY_APP_RETIRED_DEFAULT }, readToken);
      expect(g, String(flag)).toEqual({ enabled: false, reason: expect.stringContaining("RELAY_LIVE_FLY=1") });
      expect(readToken, String(flag)).not.toHaveBeenCalled();   // and the retired name did not throw: the flag comes first
      checked++;
    }
    expect(checked).toBe(5);
  });

  it("live with FLY_RELAY_APP unset, empty or blank → disabled, the reason naming the variable and an app to use; the token is never read", () => {
    let checked = 0;
    for (const app of [undefined, "", "   "]) {
      const readToken = vi.fn(() => "tok");
      const g = liveFlyGate({ ...LIVE, FLY_RELAY_APP: app }, readToken);
      expect(g.enabled, JSON.stringify(app)).toBe(false);
      if (!g.enabled) {
        expect(g.reason).toContain("FLY_RELAY_APP");
        expect(g.reason).toContain("no default");
        expect(g.reason).toContain("seazn-relay-spike");
      }
      expect(readToken).not.toHaveBeenCalled();
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("live with the RETIRED app THROWS by name (also padded) — the file fails to collect rather than skip; the token is never read", () => {
    expect(FLY_RELAY_APP_RETIRED_DEFAULT, "premise: the retired name config.ts refuses").toBe("seazn-relay");
    let checked = 0;
    for (const app of [FLY_RELAY_APP_RETIRED_DEFAULT, ` ${FLY_RELAY_APP_RETIRED_DEFAULT}\t`]) {
      const readToken = vi.fn(() => "tok");
      expect(() => liveFlyGate({ ...LIVE, FLY_RELAY_APP: app }, readToken), JSON.stringify(app)).toThrow(/RETIRED shared relay app/);
      expect(() => liveFlyGate({ ...LIVE, FLY_RELAY_APP: app }, readToken)).toThrow(FLY_RELAY_APP_RETIRED_DEFAULT);
      expect(readToken).not.toHaveBeenCalled();
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("live with an app of our own: no token → disabled naming FLY_API_TOKEN; a token → enabled with the TRIMMED app and that token", () => {
    expect(liveFlyGate({ ...LIVE, FLY_RELAY_APP: "seazn-relay-spike" }, () => undefined)).toEqual({ enabled: false, reason: expect.stringContaining("FLY_API_TOKEN") });
    expect(liveFlyGate({ ...LIVE, FLY_RELAY_APP: " seazn-relay-spike " }, () => "tok")).toEqual({ enabled: true, app: "seazn-relay-spike", token: "tok" });
    // the differential: a name that merely CONTAINS the retired one is someone's own app, not the retired one
    expect(liveFlyGate({ ...LIVE, FLY_RELAY_APP: `${FLY_RELAY_APP_RETIRED_DEFAULT}-spike` }, () => "tok")).toMatchObject({ enabled: true });
  });
});
