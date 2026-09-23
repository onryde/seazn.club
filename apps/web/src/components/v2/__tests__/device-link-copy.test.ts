import { describe, expect, it } from "vitest";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import { liveCopy } from "../device-link-copy";

const fmt = (iso: string) => `AT(${iso})`;

describe("device-link panel copy (scorer sheets §4.2)", () => {
  it("a sealed link (null expiry) says 'until the match is over' — never an epoch date", () => {
    expect(liveCopy(null, fmt)).toEqual({ key: "dlink.liveUntilOver" });
  });
  it("a dated row keeps the existing dated line (the key that already exists — no new legacy copy, ruling Q3)", () => {
    expect(liveCopy("2026-09-23T23:59:59Z", fmt)).toEqual({ key: "dlink.live", vars: { date: "AT(2026-09-23T23:59:59Z)" } });
  });
});

// Controller ruling (T3 fix round): a sealed link has no expiry since Task 2 —
// it works until the match is finalized or cancelled. The panel's description
// used to promise "today only" in every locale, which is now false on every
// hand-over screen. Pin the new lifetime per locale (the copy IS the source of
// truth here), and refuse the old "today" meaning in any of them.
const DESC: Record<string, string> = {
  en: en["dlink.desc"],
  es: es["dlink.desc"],
  fr: fr["dlink.desc"],
  nl: nl["dlink.desc"],
};
const LIFETIME: Record<string, string> = {
  en: "until it's finalized or cancelled",
  es: "hasta que se finalice o se cancele",
  fr: "jusqu'à ce qu'elle soit finalisée ou annulée",
  nl: "tot die is afgerond of geannuleerd",
};

describe("dlink.desc says how long a device link lives (no expiry since Task 2)", () => {
  it.each(Object.keys(DESC))("%s: works until the match is finalized or cancelled", (locale) => {
    expect(DESC[locale]).toContain(LIFETIME[locale]);
  });

  it.each(Object.keys(DESC))("%s: never promises 'today only' again", (locale) => {
    expect(DESC[locale]).not.toMatch(/\btoday\b|aujourd|\bhoy\b|vandaag|heute/i);
    // The rest of the sentence is still true and still there: the scorer
    // placeholder (who holds the phone scores as the {scorer}).
    expect(DESC[locale]).toContain("{scorer}");
  });
});
