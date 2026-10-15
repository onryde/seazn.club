// ClientTime / ClientDateRange / Zoned (ESLint L3): the formatted text used to
// be copied into state by a mount effect; it is now derived in render once
// hydration has committed (`useHydrated`). Two halves are owed and both are
// pinned: the SERVER/hydration render stays an empty span (Node ICU and a
// browser spell zones differently, so any text there is a hydration mismatch),
// and the hydrated render shows the time. Expected strings are built straight
// from `Intl` / `lib/format`, never read back from the component.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { renderIsland } from "@/components/__tests__/_hook-harness";
import { ClientDateRange, ClientTime, Zoned } from "../client-time";
import { fmtDateTime, fmtTime, fmtZoneAbbrev } from "@/lib/format";

const AT = "2026-08-14T13:30:00Z";
const LATER = "2026-08-16T09:05:00Z";

afterEach(() => {
  vi.restoreAllMocks();
});

const hydrate = <P,>(C: (p: P) => React.ReactNode, props: P) =>
  renderIsland(C, props, undefined, { hydrate: true });

describe("ClientTime", () => {
  it("server markup is an empty span — nothing for hydration to disagree with", () => {
    expect(renderToStaticMarkup(<ClientTime value={AT} tz="Europe/London" />)).toBe("<span></span>");
  });

  it("after hydration: the time in the given zone, in the app locale (en default)", () => {
    const expected = new Date(AT).toLocaleTimeString("en", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Europe/London",
    });
    expect(expected, "anti-vacuity: the expectation is a real clock reading").toMatch(/\d/);
    expect(hydrate(ClientTime, { value: AT, tz: "Europe/London" }).text()).toBe(expected);
  });

  it("a second value re-derives; a value that goes back to null empties (the effect left it stale)", () => {
    const island = hydrate(ClientTime, { value: AT as string | null, tz: "UTC", hourCycle: "h23" as const });
    expect(island.text()).toBe("13:30");
    island.rerender({ value: LATER, tz: "UTC", hourCycle: "h23" as const });
    expect(island.text()).toBe("09:05");
    island.rerender({ value: null, tz: "UTC", hourCycle: "h23" as const });
    expect(island.text()).toBe("");
  });

  it("empty case: no value renders nothing even after hydration", () => {
    expect(hydrate(ClientTime, { value: null }).text()).toBe("");
  });
});

describe("ClientDateRange", () => {
  it("server markup is an empty span", () => {
    expect(renderToStaticMarkup(<ClientDateRange from={AT} to={LATER} tz="UTC" />)).toBe("<span></span>");
  });

  it("after hydration: a compact range; one day collapses to a single date", () => {
    const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", timeZone: "UTC" };
    const a = new Date(AT).toLocaleDateString([], opts);
    const b = new Date(LATER).toLocaleDateString([], opts);
    expect(a).not.toBe(b);
    expect(hydrate(ClientDateRange, { from: AT, to: LATER, tz: "UTC" }).text()).toBe(`${a} – ${b}`);
    expect(hydrate(ClientDateRange, { from: AT, to: null, tz: "UTC" }).text()).toBe(a);
  });
});

describe("Zoned", () => {
  it("server markup is an empty span", () => {
    expect(renderToStaticMarkup(<Zoned value={AT} tz="Asia/Kolkata" showZone />)).toBe(
      "<span></span>",
    );
  });

  it("after hydration: the venue time with its zone, plus the viewer's own time when the zones differ", () => {
    // The viewer's browser is in London; the venue is in India.
    const real = Intl.DateTimeFormat.prototype.resolvedOptions;
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(function (
      this: Intl.DateTimeFormat,
    ) {
      return { ...real.call(this), timeZone: "Europe/London" };
    });
    const main = `${fmtDateTime("Asia/Kolkata", AT)} ${fmtZoneAbbrev("Asia/Kolkata", AT)}`;
    const local = `${fmtTime("Europe/London", AT)} ${fmtZoneAbbrev("Europe/London", AT)}`;
    const text = hydrate(Zoned, { value: AT, tz: "Asia/Kolkata", showZone: true, you: "subtitle" as const }).text();
    expect(text).toContain(main);
    expect(text).toContain(local);
  });

  it("no subtitle when the viewer is already in the venue's zone", () => {
    const real = Intl.DateTimeFormat.prototype.resolvedOptions;
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(function (
      this: Intl.DateTimeFormat,
    ) {
      return { ...real.call(this), timeZone: "Asia/Kolkata" };
    });
    const main = fmtDateTime("Asia/Kolkata", AT);
    expect(hydrate(Zoned, { value: AT, tz: "Asia/Kolkata", you: "subtitle" as const }).text()).toBe(main);
  });

  it("empty case: a null value renders nothing", () => {
    expect(hydrate(Zoned, { value: null, tz: "UTC" }).text()).toBe("");
  });
});
