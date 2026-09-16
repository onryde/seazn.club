// Owner ruling 2026-09-16: a public page's time is written in the org's
// locale (English as en-GB). The /present kiosk's wall clock called
// `toLocaleTimeString([], …)` — the BROWSER's default locale — so a TV whose
// browser is en-US showed "02:30 PM" on a board whose every other string is in
// the org's language. The locale now travels with the board's labels
// (`slideshowLabels(locale).clockLocale`, through `intlLocaleFor`).
//
// Two halves. `clockText` is the value, with its zone PINNED (a vitest worker
// ignores a TZ mutation, so an unpinned expectation would pass by accident of
// the runner). The wiring half drives the real component's clock effect and
// records the locale argument, because the value half cannot see which locale
// the effect hands over — and on a host whose default is en-GB (this one),
// `[]` and "en-GB" print the same string, so only the ARGUMENT can tell them
// apart at every runner.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { Slideshow, clockText } from "@/components/v2/slideshow";
import { slideshowLabels } from "@/server/slideshow-labels";
import { LOCALES } from "@/lib/i18n-constants";

/** 13:00Z on 5 September 2026 — 14:00 in London (BST). */
const AT = new Date("2026-09-05T13:00:00.000Z");
const TZ = "Europe/London";

describe("clockText — the board's clock in the board's locale", () => {
  it("an English board reads the 24-hour clock, never the US 12-hour one", () => {
    const en = slideshowLabels("en").clockLocale;
    expect(clockText(AT, en, TZ)).toBe("14:00");
    // The differential: bare "en" to Intl IS the 12-hour clock.
    expect(AT.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: TZ })).not.toBe("14:00");
  });

  for (const locale of LOCALES.filter((l) => l !== "en")) {
    it(`a ${locale} board reads that locale's own clock`, () => {
      const own = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", timeZone: TZ }).format(AT);
      expect(clockText(AT, slideshowLabels(locale).clockLocale, TZ)).toBe(own);
    });
  }
});

describe("<Slideshow> — the clock effect formats in the labels' locale", () => {
  const seen: unknown[] = [];
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(AT);
    // The board's keyboard effect listens on `window`; there is no DOM here.
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    seen.length = 0;
    const real = Date.prototype.toLocaleTimeString;
    vi.spyOn(Date.prototype, "toLocaleTimeString").mockImplementation(function (
      this: Date,
      locales?: Intl.LocalesArgument,
      options?: Intl.DateTimeFormatOptions,
    ) {
      seen.push(locales);
      return real.call(this, locales, options);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  for (const locale of LOCALES) {
    it(`${locale}: the clock is formatted with ${locale}'s board locale, and it is on the board`, () => {
      const labels = slideshowLabels(locale);
      const board = renderIsland(Slideshow, {
        title: "Zqx Board",
        slides: [],
        backHref: "/b",
        liveHref: "/l",
        labels,
      });
      // Non-vacuous first: a board that never ran its clock would satisfy
      // "every call used the right locale" trivially.
      expect(seen.length, "the clock effect formatted the time").toBeGreaterThan(0);
      expect(seen.every((l) => l === labels.clockLocale), `locales seen: ${JSON.stringify(seen)}`).toBe(true);
      expect(textOf(board.tree())).toContain(clockText(new Date(), labels.clockLocale));
      board.unmount();
    });
  }
});
