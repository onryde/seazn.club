// Registration defects item 8 (2026-11-18). Two registration tips said something false:
//  - `registration.ref-number` gave the example `R-7F3K`; the real reference is `SZ-XXXX-XXXX` (lib/ref-code.ts). A player told to look
//    for `R-7F3K` goes looking for a string that never appears in their mail.
//  - `registration.platform-fee` typed the per-plan fee percentages by hand, where the plan table (the matrix the pricing page and the
//    plan cards read) is the one source of truth; a retype goes stale on every re-cut. The tip now carries no figure and points at the
//    pricing page.
// The tip's live copy is the dictionary (components/ui/tip.tsx reads `tips.<id>.*` for the viewer's locale); config/tips.ts is mirrored
// by dictionary-copy-truth.test.ts for English. So all four locales are checked here, and the example is judged by the app's OWN
// reference validator, never a regex typed into this file.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TIPS } from "@/config/tips";
import { isValidRefCode } from "@/lib/ref-code";

const LOCALES = ["en", "fr", "es", "nl"] as const;
const ui = (locale: string): Record<string, string> =>
  JSON.parse(readFileSync(join(__dirname, "..", "..", "dictionaries", locale, "ui.json"), "utf8"));

describe("registration.ref-number tip", () => {
  it("quotes a reference the app itself accepts, in every locale and in tips.ts", () => {
    const bodies = [
      ...LOCALES.map((l) => ({ where: l, body: ui(l)["tips.registration.ref-number.body"]! })),
      { where: "tips.ts", body: TIPS["registration.ref-number"].body },
    ];
    let checked = 0;
    for (const { where, body } of bodies) {
      expect(body, `${where}: tip exists`).toBeTruthy();
      const quoted = body.match(/\bSZ-[A-Z0-9]{4}-[A-Z0-9]{4}\b/g) ?? [];
      expect(quoted, `${where}: names one SZ-XXXX-XXXX reference`).toHaveLength(1);
      expect(isValidRefCode(quoted[0]!), `${where}: ${quoted[0]} is a valid reference (right alphabet, right checksum)`).toBe(true);
      expect(body, `${where}: the old made-up format is gone`).not.toMatch(/\bR-7F3K\b/);
      checked += 1;
    }
    expect(checked).toBe(5);
  });
});

describe("registration.platform-fee tip", () => {
  it("states no plan percentage (the plan table is the source) and sends the reader to the pricing page, in every locale and in tips.ts", () => {
    const bodies = [
      ...LOCALES.map((l) => ({ where: l, body: ui(l)["tips.registration.platform-fee.body"]! })),
      { where: "tips.ts", body: TIPS["registration.platform-fee"].body },
    ];
    let checked = 0;
    for (const { where, body } of bodies) {
      expect(body, `${where}: tip exists`).toBeTruthy();
      expect(body, `${where}: no hand-typed percentage`).not.toMatch(/\d\s?%/);
      expect(body.toLowerCase(), `${where}: points to the pricing page`).toMatch(/pricing|tarifs|precios|prijzen/);
      checked += 1;
    }
    expect(checked).toBe(5);
  });
});
