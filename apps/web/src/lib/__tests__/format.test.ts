import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fmtDate, fmtTime, fmtDateTime, fmtZoneAbbrev, fmtRange } from "@/lib/format";

// A fixed UTC instant: 2026-08-16T13:30:00Z == 19:00 in Asia/Kolkata (IST).
const IST_1900 = "2026-08-16T13:30:00Z";

describe("fmtTime", () => {
  it("renders the wall-clock time in the given zone (h23)", () => {
    expect(fmtTime("Asia/Kolkata", IST_1900)).toBe("19:00");
    expect(fmtTime("Europe/London", IST_1900)).toBe("14:30"); // BST = UTC+1 in Aug
    expect(fmtTime("UTC", IST_1900)).toBe("13:30");
  });
  it("returns empty string for null/invalid input", () => {
    expect(fmtTime("UTC", null)).toBe("");
    expect(fmtTime("UTC", "not-a-date")).toBe("");
  });
});

describe("fmtZoneAbbrev — DST-dependent", () => {
  // The exact string is runtime-ICU-dependent: Node emits "GMT+5:30" where a
  // browser emits "IST" (why the label renders client-side). What IS invariant
  // and worth guarding: the value TRACKS DST — different in a zone's summer vs
  // winter, stable in a zone without DST — and it never throws / never blanks.
  it("Europe/London differs winter vs summer (DST tracked)", () => {
    const winter = fmtZoneAbbrev("Europe/London", "2026-01-15T12:00:00Z");
    const summer = fmtZoneAbbrev("Europe/London", "2026-07-15T12:00:00Z");
    expect(winter).toBe("GMT"); // London winter names deterministically across ICU
    expect(summer).not.toBe(winter);
    expect(summer).toBeTruthy();
  });
  it("Asia/Kolkata is stable year-round (no DST) and reads IST, not an offset", () => {
    const jan = fmtZoneAbbrev("Asia/Kolkata", "2026-01-15T12:00:00Z");
    const aug = fmtZoneAbbrev("Asia/Kolkata", IST_1900);
    expect(jan).toBe(aug);
    // The DST-free override guarantees "IST" even where ICU emits "GMT+5:30".
    expect(jan).toBe("IST");
  });
  it("keeps a runtime-provided name and only overrides offset fallbacks", () => {
    // Gulf Standard Time is DST-free; ICU offset fallback becomes GST.
    expect(fmtZoneAbbrev("Asia/Dubai", IST_1900)).toBe("GST");
    // A zone with no override keeps whatever the runtime gives (never blank).
    expect(fmtZoneAbbrev("America/New_York", IST_1900)).toBeTruthy();
  });
});

describe("unknown zone falls back to UTC, never throws", () => {
  it("fmtTime tolerates a bogus zone", () => {
    expect(() => fmtTime("Mars/Phobos", IST_1900)).not.toThrow();
    expect(fmtTime("Mars/Phobos", IST_1900)).toBe("13:30"); // UTC fallback
    // Derived rather than a second pinned literal, so it tracks the instant
    // above instead of restating it. On a NON-UTC runner this discriminates on
    // its own; on a UTC runner it cannot, which is what the child process
    // below exists for.
    expect(fmtTime("Mars/Phobos", IST_1900)).toBe(fmtTime("UTC", IST_1900));
  });

  // m1 — why the pinned "13:30" above is not enough. `fmt()` catches the
  // RangeError and REBUILDS the formatter with an explicit `timeZone: "UTC"`.
  // Delete that one option and the retry silently adopts the runtime's own
  // resolved zone instead. Under CI (TZ=UTC) both spellings of the bug render
  // "13:30", so the assertion passes on broken code; it only ever reddened on
  // a non-UTC dev box. "Falls back to UTC" and "falls back to the process
  // zone" are indistinguishable in-process whenever the process IS UTC, so no
  // assertion made in this worker can close the gap.
  //
  // Forcing the zone from inside the test does not work either: vitest runs
  // `pool: "threads"`, and assigning `process.env.TZ` / `vi.stubEnv("TZ", …)`
  // in a worker updates the variable but does NOT reset ICU's cached default
  // zone. TZ is only honoured at PROCESS SPAWN — hence a child. `lib/format.ts`
  // has no imports and only erasable type syntax, so Node loads the .ts
  // directly with no build step.
  it("renders the UTC fallback even when the process itself is in another zone", () => {
    const mod = new URL("../format.ts", import.meta.url).href;
    const probe = `
      const m = await import(${JSON.stringify(mod)});
      const AT = ${JSON.stringify(IST_1900)};
      process.stdout.write(JSON.stringify({
        bogus: m.fmtTime("Mars/Phobos", AT),
        utc: m.fmtTime("UTC", AT),
        // The same instant rendered in the process's OWN zone, with fmtTime's
        // default options — what a fallback that forgot timeZone would emit.
        ambient: new Intl.DateTimeFormat("en-GB", {
          hour: "2-digit", minute: "2-digit", hourCycle: "h23",
        }).format(new Date(AT)),
      }));`;
    // Asia/Kolkata: +05:30 and DST-free, so the offset holds all year.
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", probe], {
      env: { ...process.env, TZ: "Asia/Kolkata" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const got = JSON.parse(out) as { bogus: string; utc: string; ambient: string };

    // Precondition, asserted rather than assumed: without it a child that
    // ignored TZ would make every assertion below vacuously true. Derived from
    // the RENDER, not from resolvedOptions().timeZone — ICU canonicalises
    // Asia/Kolkata to "Asia/Calcutta", so comparing zone spellings is a trap.
    expect(got.ambient, "the forced TZ never took — the rest proves nothing").not.toBe(got.utc);

    // The discrimination the pinned literal cannot make, at ANY runner zone.
    expect(got.bogus, "fell back to the process zone, not to UTC").toBe(got.utc);
    expect(got.bogus).not.toBe(got.ambient);
  });
});

describe("fmtDate / fmtDateTime", () => {
  it("formats a date in-zone", () => {
    // 13:30Z is still 16 Aug in Kolkata but also 16 Aug in London.
    expect(fmtDate("Asia/Kolkata", IST_1900)).toContain("16 Aug");
  });
  it("crosses midnight by zone", () => {
    // 22:30Z on the 16th is 04:00 on the 17th in Kolkata.
    expect(fmtDate("Asia/Kolkata", "2026-08-16T22:30:00Z")).toContain("17 Aug");
    expect(fmtDate("UTC", "2026-08-16T22:30:00Z")).toContain("16 Aug");
  });
  it("fmtDateTime combines both", () => {
    expect(fmtDateTime("UTC", IST_1900)).toMatch(/16 Aug/);
  });
});

describe("fmtRange", () => {
  it("collapses a single day", () => {
    expect(fmtRange("UTC", IST_1900, IST_1900)).toBe("16 Aug");
  });
  it("shows a span across days", () => {
    expect(fmtRange("UTC", "2026-08-12T10:00:00Z", "2026-08-14T10:00:00Z")).toBe("12 Aug – 14 Aug");
  });
  it("treats missing 'to' as single day", () => {
    expect(fmtRange("UTC", IST_1900, null)).toBe("16 Aug");
  });
});
