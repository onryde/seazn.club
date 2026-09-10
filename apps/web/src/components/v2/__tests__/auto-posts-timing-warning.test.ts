// News auto-drafting is a side effect of FOLDING a result (`refreshNews`,
// usecases/scoring.ts:132). An org that switches it on after play has started
// gets nothing for what is already scored, and re-folding is not something
// anyone may do to recover — so the cost of learning late is unbounded and
// unrecoverable. The recorded finding: "any surface that offers auto-posting
// should surface the entitlement requirement BEFORE scoring starts, not at the
// moment the toggle is flipped."
//
// `apps/web` vitest is environment: "node" — there is no DOM here, so this
// cannot assert the warning is VISIBLE (the e2e suite is where that lives).
// What it can pin is the thing a future edit would silently break: that the
// warning exists in all four locales, and that it sits OUTSIDE the
// `canAutoPost` branch. An org still looking at the UpgradeGate is precisely
// the one that must read it.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const SOURCE = readFileSync(join(ROOT, "components", "v2", "division-settings.tsx"), "utf8");
const LOCALES = ["en", "es", "fr", "nl"] as const;

function dict(locale: string): Record<string, string> {
  return JSON.parse(
    readFileSync(join(ROOT, "dictionaries", locale, "ui.json"), "utf8"),
  ) as Record<string, string>;
}

describe("auto-posts timing warning", () => {
  it("exists in all four locales, non-empty", () => {
    for (const locale of LOCALES) {
      const value = dict(locale)["divset.news.timing"];
      expect(value, locale).toBeTruthy();
      expect(value!.length, locale).toBeGreaterThan(20);
    }
  });

  it("is actually translated, not English pasted into four files", () => {
    // The failure this catches is real and quiet: a key added to en/ and
    // copied verbatim into the other three passes every parity check.
    const en = dict("en")["divset.news.timing"]!;
    for (const locale of LOCALES.filter((l) => l !== "en")) {
      expect(dict(locale)["divset.news.timing"], locale).not.toBe(en);
    }
  });

  it("the settings panel renders it", () => {
    expect(SOURCE).toContain('msg("divset.news.timing")');
  });

  it("renders OUTSIDE the entitlement branch — the un-entitled org must see it", () => {
    // The whole point of the finding. If a later edit tucks this inside the
    // `canAutoPost ?` true-branch, the only org that needs the warning is the
    // one that stops getting it, and nothing else in the suite would notice.
    const gate = SOURCE.indexOf('<UpgradeGate feature="news.auto"');
    const warning = SOURCE.indexOf('data-testid="auto-posts-timing"');
    expect(gate, "the UpgradeGate branch should still exist").toBeGreaterThan(-1);
    expect(warning, "the timing warning should still exist").toBeGreaterThan(-1);
    // After the gate means after the ternary's false-branch, i.e. after both.
    expect(warning).toBeGreaterThan(gate);
  });

  it("warns about the timing specifically, not merely about the plan", () => {
    // A generic "this needs Pro" line would satisfy every assertion above and
    // miss the finding entirely: the hazard is WHEN you switch it on, not
    // WHETHER you are entitled. featureReason("news.auto") already covers the
    // plan, and is English-only.
    const en = dict("en")["divset.news.timing"]!.toLowerCase();
    expect(en).toMatch(/later|before|already/);
  });
});
