// The tail countdown's arithmetic (O16): anchored to the server's `now`, only the reader's own elapsed time is added, so the
// reader's clock being wrong changes nothing. Pure; the component around it is `court-tail-countdown.tsx`.
import { describe, expect, it } from "vitest";
import { tailSecondsLeft } from "../tail-countdown";

const VIEW_NOW = "2026-10-31T12:00:00.000Z";
const at = (ms: number): string => new Date(Date.parse(VIEW_NOW) + ms).toISOString();
const left = (tailMs: number, anchoredAtMs: number, nowMs: number, viewNow = VIEW_NOW) =>
  tailSecondsLeft({ tailEndsAt: at(tailMs), viewNow, anchoredAtMs, nowMs });

describe("tailSecondsLeft", () => {
  it("a fresh anchor counts the whole gap to the end, rounded up", () => {
    expect(left(12_000, 1_000_000, 1_000_000)).toBe(12);
    expect(left(11_200, 1_000_000, 1_000_000)).toBe(12);
    expect(left(400, 1_000_000, 1_000_000)).toBe(1);
  });
  it("after 5 s on the reader's clock, 5 s fewer", () => {
    expect(left(12_000, 1_000_000, 1_005_000)).toBe(7);
    expect(left(12_000, 1_000_000, 1_005_001)).toBe(7);
    expect(left(12_000, 1_000_000, 1_005_999)).toBe(7);
    expect(left(12_000, 1_000_000, 1_006_000)).toBe(6);
  });
  it("a reader's clock an hour off (either way) changes nothing: only elapsed time on it counts", () => {
    const hour = 3_600_000;
    expect(left(12_000, hour, hour + 5_000)).toBe(7);
    expect(left(12_000, -hour, -hour + 5_000)).toBe(7);
  });
  it("a new view re-anchors: a later viewNow with a later anchor restarts from its own gap", () => {
    // 5 s on, still the old view: 7 s. The poll brings a view 5 s later whose tail is the same instant, anchored now.
    expect(left(12_000, 1_000_000, 1_005_000)).toBe(7);
    expect(tailSecondsLeft({ tailEndsAt: at(12_000), viewNow: at(5_000), anchoredAtMs: 1_005_000, nowMs: 1_005_000 })).toBe(7);
    expect(tailSecondsLeft({ tailEndsAt: at(12_000), viewNow: at(5_000), anchoredAtMs: 1_005_000, nowMs: 1_008_000 })).toBe(4);
  });
  it("clamps at 0 once the end has passed, and never reads a backwards clock as extra time", () => {
    expect(left(12_000, 1_000_000, 1_012_000)).toBe(0);
    expect(left(12_000, 1_000_000, 1_090_000)).toBe(0);
    expect(left(12_000, 1_000_000, 900_000), "the reader's clock stepped back").toBe(12);
  });
  it("an unreadable instant is no countdown", () => {
    expect(tailSecondsLeft({ tailEndsAt: "soon", viewNow: VIEW_NOW, anchoredAtMs: 0, nowMs: 0 })).toBe(0);
  });
});
