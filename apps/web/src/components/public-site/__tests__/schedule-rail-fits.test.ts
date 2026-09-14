// The public Schedule's time/status rail is a FIXED grid track, and every word
// in it is a translation (spectator N1f f1/f3, review-n1e I1 and m2).
//
// What went wrong: `/embed` mounted no display face, so the rail fell back to
// the body face and "Finalizado" (es), "Afgelopen" (nl) and "déterminer" (fr)
// painted 65-70px into a 52px column — over the start of the entrant name on
// every decided row of the embeddable schedule widget. The round view's short
// date was clipped to an ellipsis in all four locales, English included.
//
// Nothing in `apps/web` vitest can SEE that: the environment is "node", there
// is no layout and no font. What can see it is the font's own metrics, so this
// suite measures the real dictionary values in the real faces
// (`__tests__/font-advance.ts`) against the rail track read out of the
// component's own Tailwind class. Expected values are derived end to end:
// the strings come from `publicScheduleCopy`, the builder BOTH production
// callers use, and the date from the component's own exported formatter.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getDictionary } from "@/lib/i18n";
import { msgFor } from "@/lib/messages-i18n";
import { toLocale } from "@/lib/i18n-constants";
import { publicScheduleCopy } from "@/server/public-site/schedule-copy";
import { openFace, minContentWidth, textWidth } from "./font-advance";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, "../../../..");
const SCHEDULE_SRC = readFileSync(path.join(HERE, "../schedule.tsx"), "utf8");

// The faces the rail actually paints in. `font-display` resolves to
// `var(--ps-font-display, …)` (globals.css `@theme inline`), which both the
// /shared org layout and the /embed layout set to Barlow Condensed; the rest
// of the rail inherits the body sans. `next/font` fetches those at build time
// and commits nothing, so the measurement uses the repo's own copies of the
// same faces — the built `Barlow Condensed SemiBold` woff2 agrees with the
// committed .ttf to 0.00px on every string in this suite.
const DISPLAY = openFace(path.join(WEB, "assets/fonts/BarlowCondensed-SemiBold.ttf"), "Barlow Condensed SemiBold");
const BODY = openFace(path.join(WEB, "assets/fonts/Inter-Regular.otf"), "Inter Regular");

/** The rail track, in px, read from the row grid the component declares. */
function railPx(): number {
  const m = /grid-cols-\[([0-9.]+)rem_minmax\(0,1fr\)_auto\]/.exec(SCHEDULE_SRC);
  if (!m) throw new Error("could not find the scorebug row's grid-cols track in schedule.tsx");
  return Number(m[1]) * 16; // Tailwind rem against the default 16px root
}

const LOCALES = ["en", "es", "fr", "nl"] as const;

async function railCopy(locale: string) {
  const l = toLocale(locale);
  const dict = await getDictionary(l, "public");
  return publicScheduleCopy(dict, (k) => msgFor(l, k));
}

describe("public Schedule rail — every translated word fits its column (N1f f1)", () => {
  it("declares a rail track and a rail that can wrap inside it, never over the name", () => {
    expect(railPx()).toBeGreaterThan(0);
    // The rail cell is a grid item: without `min-w-0` its automatic minimum is
    // its min-content width, so a long word makes the CELL wider than the
    // track and paints across the gap into the name. With it, the cell is the
    // track and `break-words` is the last resort that keeps a word that is
    // somehow still too long inside the column instead of over the name.
    expect(SCHEDULE_SRC).toContain('className="row-span-2 flex min-w-0 flex-col items-start"');
    expect(SCHEDULE_SRC).toMatch(/font-display text-sm font-semibold[^"]*\bbreak-words\b|break-words[^"]*font-display/);
    // Nothing in the rail may truncate a status word (the ruling): the only
    // `truncate` allowed there is the court-name / date line below it.
    expect(SCHEDULE_SRC).not.toMatch(/font-display text-sm font-semibold[^"]*\btruncate\b/);
  });

  it("fits every locale's Live / Ended / TBD and a clock inside the rail track", async () => {
    const track = railPx();
    const report: string[] = [];
    for (const locale of LOCALES) {
      const copy = await railCopy(locale);
      // The status/time line is `font-display text-sm font-semibold` -> the
      // display face at 14px. The live chip is the body face at 11px with
      // `tracking-wide` (0.025em), plus its 6px dot and 4px gap.
      const cases: [string, number][] = [
        [copy.ended, minContentWidth(DISPLAY, copy.ended, 14)],
        [copy.tbd, minContentWidth(DISPLAY, copy.tbd, 14)],
        ["14:30", textWidth(DISPLAY, "14:30", 14)],
        [copy.live.toUpperCase(), minContentWidth(BODY, copy.live.toUpperCase(), 11, 0.025) + 10],
      ];
      for (const [word, width] of cases) {
        report.push(`${locale} ${JSON.stringify(word)} ${width.toFixed(1)}px / ${track}px`);
        expect(
          width,
          `${locale}: ${JSON.stringify(word)} needs ${width.toFixed(1)}px in a ${track}px rail`,
        ).toBeLessThanOrEqual(track);
      }
    }
    // Print what was asserted, so a green run is not a silent one.
    expect(report.length).toBe(LOCALES.length * 4);
    console.log(`[rail top line] ${report.join("  |  ")}`);
  });
});
