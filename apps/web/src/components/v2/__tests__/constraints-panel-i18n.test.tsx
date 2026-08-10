// The constraints panel shipped half-internationalised: the min-rest row and
// the blackout editor (min-rest-tip.test.tsx, blackout-editor.test.tsx) read
// copy from the dict, but the rules sheet, bulk-shift card and wait-time
// report were hardcoded English. This suite pins the newly-converted half.
//
// Reachability note: under `renderToStaticMarkup`, `useState` initialisers
// run but no event ever fires, so `busy` and `report` never leave their
// initial `false`/`null`. That makes the wait-report TABLE (its headers,
// empty state, footer) and the "Checking…" busy label unreachable from a
// bare render — proving those would need the report step pulled out as its
// own component, which is out of scope here. KEY_COVERAGE below proves them
// a different way: every `constraints.*` key this file actually references,
// resolved to a non-empty string in all four locales, without needing to
// reach the state that displays it.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ConstraintsPanel } from "../constraints-panel";
import { DictProvider } from "@/components/i18n/dict-provider";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";
import type { Dict, Locale } from "@/lib/i18n-constants";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

// `useConfirm` throws outside its provider (context default is null) and
// this harness has no provider tree — same mock min-rest-tip.test.tsx uses.
// Nothing here exercises the bulk-shift confirm dialog's own copy.
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => async () => true,
}));

const en = enUi as Record<string, string>;

const NON_ENGLISH: [Locale, Dict][] = [
  ["es", esUi as Dict],
  ["fr", frUi as Dict],
];

const ALL_DICTS: [Locale, Dict][] = [
  ["en", enUi as Dict],
  ["es", esUi as Dict],
  ["fr", frUi as Dict],
  ["nl", nlUi as Dict],
];

const BASE_SETTINGS: { division_id: string; config: Record<string, unknown> } = {
  division_id: "d1",
  config: { courts: ["Court 1"], matchMinutes: 30, gapMinutes: 0 },
};

// Forces the `{n} start window(s) set.` row into the render — otherwise
// gated behind `constraints.startWindows.length > 0`.
const SETTINGS_WITH_START_WINDOWS: { division_id: string; config: Record<string, unknown> } = {
  division_id: "d1",
  config: {
    courts: ["Court 1"],
    matchMinutes: 30,
    gapMinutes: 0,
    constraints: {
      startWindows: [
        { target: { kind: "division", id: "d1" } },
        { target: { kind: "division", id: "d1" } },
      ],
    },
  },
};

const renderConstraints = (
  dict: Dict,
  locale: Locale,
  initialSettings: { division_id: string; config: Record<string, unknown> } = BASE_SETTINGS,
) =>
  renderToStaticMarkup(
    <DictProvider dict={dict} locale={locale}>
      <ConstraintsPanel divisionId="d1" initialSettings={initialSettings} canEdit orgTz="Europe/London" />
    </DictProvider>,
  );

/** React escapes text-node/attribute punctuation; comparing a raw dictionary
 *  string containing `'` or `&` against the markup silently never matches. */
const escapeHtml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

/** Mirrors lib/i18n-runtime.ts `interpolate` — `{var}` substitution only. */
const interp = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

// Only keys reachable from a BARE static render — see file header. Each is
// asserted against BOTH the translated text (present) and the English
// literal (absent), so a reverted `msg()` call fails this, not just a
// "missing dictionary key" check.
const RENDERED_KEYS: { key: string; vars?: Record<string, string | number> }[] = [
  { key: "constraints.panel.title" },
  { key: "constraints.panel.ariaLabel" },
  { key: "constraints.rules.heading" },
  { key: "constraints.rules.intro" },
  { key: "constraints.crossPersonClash.label" },
  { key: "constraints.crossPersonClash.hint" },
  { key: "constraints.noBackToBack.label" },
  { key: "constraints.noBackToBack.hint" },
  { key: "constraints.fieldFairness.label" },
  { key: "constraints.fieldFairness.hint" },
  { key: "constraints.fieldFairness.off" },
  { key: "constraints.fieldFairness.balance" },
  { key: "constraints.fieldFairness.rotate" },
  { key: "constraints.bulkShift.heading" },
  { key: "constraints.bulkShift.minutesAriaLabel" },
  { key: "constraints.bulkShift.unit" },
  { key: "constraints.bulkShift.button" },
  { key: "constraints.bulkShift.hint" },
  { key: "constraints.waitReport.heading" },
  { key: "constraints.waitReport.intro" },
  { key: "constraints.waitReport.check" },
];

describe("constraints panel i18n — newly-converted strings", () => {
  for (const [locale, dict] of NON_ENGLISH) {
    it(`renders every converted string in ${locale}, and drops the English literal`, () => {
      const html = renderConstraints(dict, locale);
      for (const { key, vars } of RENDERED_KEYS) {
        const enRaw = en[key];
        const translatedRaw = dict[key] as string;
        expect(translatedRaw, `${locale} is missing ${key}`).toBeTruthy();

        const translated = vars ? interp(translatedRaw, vars) : translatedRaw;
        expect(html, `${locale}/${key} did not render`).toContain(escapeHtml(translated));

        // A couple of short words are genuine cognates (French "minutes" is
        // spelled the same in English) — asserting English is absent would
        // be a vacuous check that always fails, not a strict one, so only
        // assert it where the translation actually differs.
        if (translatedRaw !== enRaw) {
          const englishRendered = vars ? interp(enRaw, vars) : enRaw;
          expect(html, `${locale}/${key} still shows the English literal`).not.toContain(
            escapeHtml(englishRendered),
          );
        }
      }
    });
  }

  it("interpolates {n} into the start-windows count, in es", () => {
    const html = renderConstraints(esUi as Dict, "es", SETTINGS_WITH_START_WINDOWS);
    const translated = interp((esUi as Record<string, string>)["constraints.startWindows.count"], { n: 2 });
    expect(html).toContain(escapeHtml(translated));
    expect(html).not.toContain("start window");
  });

  it("en renders its own copy (harness sanity check)", () => {
    const html = renderConstraints(enUi as Dict, "en");
    for (const { key, vars } of RENDERED_KEYS) {
      const raw = en[key];
      const text = vars ? interp(raw, vars) : raw;
      expect(html, `en/${key} did not render`).toContain(escapeHtml(text));
    }
  });

  it("every constraints.* key this file references resolves to a non-empty string in all four locales", () => {
    const srcPath = fileURLToPath(new URL("../constraints-panel.tsx", import.meta.url));
    const src = readFileSync(srcPath, "utf8");
    const found = new Set<string>();
    const keyPattern = /"(constraints\.[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)"/g;
    let m: RegExpExecArray | null;
    while ((m = keyPattern.exec(src))) found.add(m[1]);

    // A regression net on the scan itself: if this collapses toward 0, the
    // loop below passes vacuously (0 checks) instead of proving anything.
    expect(found.size, "source scan found suspiciously few constraints.* keys").toBeGreaterThanOrEqual(30);

    for (const [locale, dict] of ALL_DICTS) {
      const record = dict as Record<string, unknown>;
      for (const key of found) {
        const value = record[key];
        expect(typeof value, `${locale} is missing ${key}`).toBe("string");
        expect((value as string).length, `${locale}/${key} is an empty string`).toBeGreaterThan(0);
      }
    }
  });
});
