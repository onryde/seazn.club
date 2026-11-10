// W4 B5b review m-5: ONE fact, two dictionaries. The organiser's tile reads the ui dictionary (`bracket.jointWinners`,
// `bracket.titleVacant`); the public bracket, schedule row and match page read the public dictionary (`title.joint`,
// `title.vacant`). Nothing else keeps them equal, so this does - per locale, over the locales on disk.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..", "dictionaries");
const PAIRS = [
  ["bracket.jointWinners", "title.joint"],
  ["bracket.titleVacant", "title.vacant"],
] as const;
const read = (loc: string, file: string) => JSON.parse(readFileSync(join(ROOT, loc, file), "utf8")) as Record<string, string>;

describe("organiser and public wording of a joint / vacant title agree", () => {
  it("every locale: ui bracket.* equals public title.*", () => {
    const locales = readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    expect(locales.length, "anti-vacuity: the locales found").toBeGreaterThanOrEqual(4);
    let checked = 0;
    for (const loc of locales) {
      const ui = read(loc, "ui.json");
      const pub = read(loc, "public.json");
      for (const [uiKey, pubKey] of PAIRS) {
        expect(ui[uiKey], `${loc} ${uiKey}`).toBeTruthy();
        expect(ui[uiKey], `${loc}: ${uiKey} vs ${pubKey}`).toBe(pub[pubKey]);
        checked++;
      }
    }
    expect(checked).toBe(locales.length * PAIRS.length);
  });
});
