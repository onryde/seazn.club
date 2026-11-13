// "Not saved — deleted on {date}" (owner 2026-11-12; review I1, controller ruling 2026-11-13): the day must NEVER be later
// than the day the sweep really deletes the match. The sweep deletes on the instant (`expires_at < now`), so the day is the
// guest's own calendar day of that instant: named in the browser's zone once the page is live, and, before that (the
// server's HTML, a browser without the script), the UTC day of `expires_at − 14h`, which no zone on Earth reads as later.
//
// Expected days are written from the rule by hand (an instant, a zone's offset, the calendar), never from the formatter
// under test: 02:00Z on 21 November is 21:00 on the 20th in New York (UTC−5 in November) and 11:00 on the 21st in Tokyo
// (UTC+9); 20:00Z on the 21st is 05:00 on the 22nd in Tokyo.
//
// Sport: not applicable (a date line; no sport is read).
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";
import { NEVER_LATE_HOURS, QuickMatchDeletionLine, deletionDayFallback, deletionDayIn } from "../deletion-line";

const LINE = "Not saved — deleted on {date}";
const FR_LINE = "Non enregistré — sera supprimé le {date}";

/** The guest's zone, as the browser reports it: `Intl.DateTimeFormat().resolvedOptions().timeZone`. */
function guestIn(timeZone: string) {
  const real = Intl.DateTimeFormat.prototype.resolvedOptions;
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(function (this: Intl.DateTimeFormat) {
    return { ...real.call(this), timeZone };
  });
}
afterEach(() => vi.restoreAllMocks());

/** The line the island shows, after hydration (the live page) or as the server sent it. */
function lineOf(props: { expiresAt: string; lang: string; line: string }, live: boolean): string {
  if (!live) return renderToStaticMarkup(<QuickMatchDeletionLine {...props} />).replace(/<[^>]+>/g, "");
  const island = renderIsland(QuickMatchDeletionLine, props, undefined, { hydrate: true });
  const p = walk(island.tree() as never).find((el) => propsOf(el)["data-testid"] === "qm-not-saved");
  if (!p) throw new Error("no qm-not-saved line");
  return textOf(p);
}

describe("the day in the guest's own zone (the live page)", () => {
  it("an expiry at 02:00Z read in New York is the EARLIER day; in Tokyo, the same day", () => {
    guestIn("America/New_York");
    expect(lineOf({ expiresAt: "2026-11-21T02:00:00.000Z", lang: "en", line: LINE }, true)).toBe(
      "Not saved — deleted on 20 November 2026",
    );
    vi.restoreAllMocks();
    guestIn("Asia/Tokyo");
    expect(lineOf({ expiresAt: "2026-11-21T02:00:00.000Z", lang: "en", line: LINE }, true)).toBe(
      "Not saved — deleted on 21 November 2026",
    );
  });

  it("an expiry at 20:00Z read in Tokyo is the NEXT day; in the viewer's language (fr)", () => {
    guestIn("Asia/Tokyo");
    expect(lineOf({ expiresAt: "2026-11-21T20:00:00.000Z", lang: "fr", line: FR_LINE }, true)).toBe(
      "Non enregistré — sera supprimé le 22 novembre 2026",
    );
  });
});

describe("before the script runs: the UTC day of expires_at − 14h, never later than the guest's", () => {
  it("the server's HTML (what a browser without the script keeps) names the fallback day", () => {
    // 02:00Z on the 21st − 14h = 12:00Z on the 20th; 20:00Z on the 21st − 14h = 06:00Z on the 21st.
    expect(lineOf({ expiresAt: "2026-11-21T02:00:00.000Z", lang: "en", line: LINE }, false)).toBe(
      "Not saved — deleted on 20 November 2026",
    );
    expect(lineOf({ expiresAt: "2026-11-21T20:00:00.000Z", lang: "en", line: LINE }, false)).toBe(
      "Not saved — deleted on 21 November 2026",
    );
    expect(NEVER_LATE_HOURS).toBe(14);
  });

  // The rule itself (the two cases above pin that the line uses it): the UTC day of `instant − NEVER_LATE_HOURS` is never
  // after the day any zone reads the instant in.
  it("the rule is never a later day than any zone reads the instant: every hour of two days × every whole offset from −12 to +14", () => {
    // ISO dates compare as strings. The zones are the fixed-offset IANA names (Etc/GMT+12 is UTC−12, sign inverted).
    const iso = (ms: number, timeZone: string) => new Intl.DateTimeFormat("en-CA", { timeZone }).format(ms);
    const zones = Array.from({ length: 27 }, (_, i) => i - 12).map((o) => (o === 0 ? "UTC" : `Etc/GMT${o > 0 ? "-" : "+"}${Math.abs(o)}`));
    let checked = 0;
    const late: string[] = [];
    for (let h = 0; h < 48; h++) {
      const at = Date.UTC(2026, 10, 20, h, 30);
      const fallback = iso(at - NEVER_LATE_HOURS * 3_600_000, "UTC");
      for (const z of zones) {
        if (fallback > iso(at, z)) late.push(`${new Date(at).toISOString()} in ${z}`);
        checked++;
      }
    }
    expect(late).toEqual([]);
    expect(checked).toBe(48 * 27);
  });

  it("an instant that does not parse names no day (no line), never a throw into the render", () => {
    expect(deletionDayFallback("not a date", "en")).toBeNull();
    expect(deletionDayIn("not a date", "en", "UTC")).toBeNull();
    expect(renderToStaticMarkup(<QuickMatchDeletionLine expiresAt="not a date" lang="en" line={LINE} />)).toBe("");
  });
});
