import { describe, expect, it } from "vitest";
import { ACTIVE_STATES, TERMINAL_STATES, holdStateOf } from "../session";

describe("holdStateOf — what 'held' means to a person (spec §5.3)", () => {
  it("every ACTIVE state holds the destination and every TERMINAL state releases it — both lists the domain's own", () => {
    let checked = 0;
    for (const s of ACTIVE_STATES) { expect(holdStateOf(s), s).not.toBeNull(); checked++; }
    for (const s of TERMINAL_STATES) { expect(holdStateOf(s), s).toBeNull(); checked++; }
    expect(checked).toBe(ACTIVE_STATES.length + TERMINAL_STATES.length);
    expect(checked).toBeGreaterThan(0);
  });
  it("live and ending read 'live'; requested, provisioning and warming read 'waiting' (a phone has not connected yet)", () => {
    expect(ACTIVE_STATES.filter((s) => holdStateOf(s) === "live")).toEqual(["live", "ending"]);
    expect(ACTIVE_STATES.filter((s) => holdStateOf(s) === "waiting")).toEqual(["requested", "provisioning", "warming"]);
  });
});
