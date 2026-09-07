// V305 — the division Settings tab no longer asks for a timezone. The zone is
// an organisation setting and is inherited; asking per division was a question
// organisers could not answer consistently and the answers drifted.
//
// Pins the render contract in all four locales so a translated label cannot
// smuggle the field back in.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StandaloneScheduleSettings } from "@/components/v2/board/settings-panel";
import { zonedDateInput } from "@/lib/zoned-datetime";
import { DictProvider } from "@/components/i18n/dict-provider";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";
import type { Dict, Locale } from "@/lib/i18n-constants";
import type { BoardConfig } from "@/components/v2/board/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

/** The VENUE clock this panel reads and writes on (`settings.orgTz`, #448).
 *  Non-UTC and not the process's own zone, so an expectation derived through it
 *  cannot be satisfied by a browser-zone implementation. */
const ORG_TZ = "Pacific/Auckland";

const config: BoardConfig = {
  startAt: "2026-08-01T09:00:00.000Z",
  endAt: null,
  matchMinutes: 30,
  gapMinutes: 0,
  courts: ["Court 1"],
  perEntrantMinRest: 0,
  blackouts: [],
  sessionWindows: [],
};

const DICTS: [Locale, Dict, RegExp][] = [
  ["en", enUi as Dict, /Timezone/i],
  ["es", esUi as Dict, /Zona horaria/i],
  ["fr", frUi as Dict, /Fuseau horaire/i],
  ["nl", nlUi as Dict, /Tijdzone/i],
];

function render(locale: Locale, dict: Dict): string {
  return renderToStaticMarkup(
    <DictProvider dict={dict} locale={locale}>
      <StandaloneScheduleSettings
        divisionId="d1"
        config={config}
        canEdit
        constraintsAllowed
        venueCap="Court"
        orgTz={ORG_TZ}
        viewerPlan="community"
      />
    </DictProvider>,
  );
}

describe("division schedule settings — no timezone field", () => {
  for (const [locale, dict, label] of DICTS) {
    it(`renders no timezone control (${locale})`, () => {
      const html = render(locale, dict);
      // The panel itself still renders (guards against a vacuous pass).
      expect(html).toContain("input");
      expect(html).not.toMatch(label);
    });
  }

  it("has no dictionary key for a division timezone left behind", () => {
    for (const [, dict] of DICTS) {
      expect(dict["boardset.timezone"]).toBeUndefined();
      expect(dict["boardset.timezoneHint"]).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Date/time UX programme, Prompt 04. Every date/time control in this panel is
// the shared `DateTimeField`, never hand-rolled markup. There is no jsdom in
// this workspace, so the only fingerprint a suite can see is the class the
// component renders — `input w-full text-base`, where a hand-rolled call site
// renders `input w-full`. (`sm:text-sm` is deliberately absent: globals.css
// Pattern 5 already forces 16px on every control under 40rem.)
//
// Rewritten for the quarter-hour picker
// (docs/superpowers/specs/2026-08-10-quarter-hour-time-select-design.md):
// Chrome's clock POPUP ignores `step` (measured, Chrome 151), so neither
// `type="time"` nor `type="datetime-local"` renders anywhere on this panel
// any more. `kind="time"` (play-from/play-until) is now a native `<select>`;
// `kind="datetime-local"` (start) splits into a date `<input>` beside that
// same kind of select (`DateTimeSplitField`). Four logical FIELDS now render
// as five underlying elements: two `<input type="date">` (start's date half
// + end) and three `<select>` (start's time half + play-from + play-until).
// ---------------------------------------------------------------------------

const SHARED_FIELD_CLASS = 'class="input w-full text-base"';

/** React escapes text nodes, so a dictionary sentence is never a raw substring. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/** Every `<input>` tag of one type. `type` is the first attribute React emits
 *  for these, and `type="date"` cannot match `type="datetime-local"`. */
function inputsOfType(html: string, type: string): string[] {
  return html.match(new RegExp(`<input[^>]*type="${type}"[^>]*>`, "g")) ?? [];
}

describe("division schedule settings — date/time inputs use the shared DateTimeField", () => {
  it("renders all four date/time controls through DateTimeField", () => {
    const html = render("en", enUi as Dict);
    // No raw clock input survives — the datetime-local start field is now a
    // date input + select pair, and the time fields are selects.
    expect(inputsOfType(html, "datetime-local")).toHaveLength(0);
    expect(inputsOfType(html, "time")).toHaveLength(0);
    const dateTags = inputsOfType(html, "date");
    const selectTags = html.match(/<select[^>]*>/g) ?? [];
    // Two date inputs (start's date half + end) and three selects (start's
    // time half + play-from + play-until) — the same four fields, split.
    expect(dateTags).toHaveLength(2);
    expect(selectTags).toHaveLength(3);
    for (const tag of [...dateTags, ...selectTags]) {
      expect(tag).toContain(SHARED_FIELD_CLASS);
    }
  });

  it("leaves the panel's non-date/time inputs alone", () => {
    // Guards against a blanket class rewrite: the three duration fields are
    // number inputs, not date/time controls, and keep plain `input w-full`.
    const html = render("en", enUi as Dict);
    const numbers = inputsOfType(html, "number");
    expect(numbers).toHaveLength(3);
    for (const tag of numbers) {
      expect(tag).toContain('class="input w-full"');
      expect(tag).not.toContain("text-base");
    }
  });

  it("preserves each field's own min wiring individually", () => {
    const startIso = config.startAt;
    if (!startIso) throw new Error("fixture must set config.startAt");
    const html = render("en", enUi as Dict);
    // The end DATE may not precede the start: derived from the start field's
    // own value on the VENUE clock, and DateTimeField has to forward it as an
    // attribute. Derived rather than hardcoded, but through the org zone now —
    // reading it in the process's zone would name a different day. The end
    // date is the SECOND `<input type="date">` in the grid — the first is
    // the start field's own date half (its `kind="datetime-local"` splits
    // into one), which the panel never bounds with a min of its own.
    const dateTags = inputsOfType(html, "date");
    expect(dateTags).toHaveLength(2);
    expect(dateTags[0]).not.toContain("min=");
    expect(dateTags[1]).toContain(`min="${zonedDateInput(startIso, ORG_TZ)}"`);
    // The play-hours pair (and the start field's own time half) stay
    // unbounded too — a `min` there would be a new constraint. `<select>`
    // carries no `min` ATTRIBUTE at the DOM level at all, so the meaningful
    // check is that each still offers the full quarter-hour grid: a real min
    // filter (time-options.ts `filterByMin`) would have dropped its earliest
    // entries.
    const selectBlocks = html.match(/<select[^>]*>[\s\S]*?<\/select>/g) ?? [];
    expect(selectBlocks).toHaveLength(3);
    for (const block of selectBlocks) {
      expect(block).toContain('value="00:00"');
    }
  });

  it("keeps every date/time field's label and hint copy", () => {
    const html = render("en", enUi as Dict);
    for (const key of [
      "boardset.startAt",
      "boardset.startAtHint",
      "boardset.endAt",
      "boardset.endAtHint",
      "boardset.playFrom",
      "boardset.playUntil",
      "boardset.playHoursHint",
    ] as const) {
      expect(html, key).toContain(escapeHtml(enUi[key]));
    }
    // The play-hours pair used to carry its names as `aria-label` on a bare
    // input. DateTimeField names them with a real wrapping <label> instead
    // (sr-only, since the legend above already says "Play hours"), so the
    // attribute must be gone from THESE selects — unlike the datetime-local
    // split's own time half, which legitimately carries its OWN "Time"
    // aria-label to stay distinct from the date half beside it.
    for (const key of ["boardset.playFrom", "boardset.playUntil"] as const) {
      const found = new RegExp(`<span class="label sr-only">${escapeHtml(enUi[key])}</span><select[^>]*>`).exec(
        html,
      );
      expect(found, key).not.toBeNull();
      expect(found![0]).not.toContain("aria-label=");
    }
  });

  it("hides only the play-hours labels, which the legend above already states", () => {
    const html = render("en", enUi as Dict);
    // `<legend class="label">Play hours (daily)</legend>` already says this, so
    // a second visible line per input is duplication — and the extra `.label`
    // row knocked this cell 20px taller than the match-length field sharing its
    // grid row. The element still RENDERS, which is what keeps them named.
    for (const key of ["boardset.playFrom", "boardset.playUntil"] as const) {
      expect(html, key).toContain(`<span class="label sr-only">${escapeHtml(enUi[key])}</span>`);
    }
    // Start and end have no legend above them and keep visible labels — this is
    // a targeted exception, not a new house style for date/time fields.
    for (const key of ["boardset.startAt", "boardset.endAt"] as const) {
      expect(html, key).toContain(`<span class="label">${escapeHtml(enUi[key])}</span>`);
    }
  });

  it("still disables all four when the viewer cannot edit", () => {
    const html = renderToStaticMarkup(
      <DictProvider dict={enUi as Dict} locale="en">
        <StandaloneScheduleSettings
          divisionId="d1"
          config={config}
          canEdit={false}
          constraintsAllowed
          venueCap="Court"
          orgTz={ORG_TZ}
          viewerPlan="community"
        />
      </DictProvider>,
    );
    // Two date inputs (start's date half + end) and three selects (start's
    // time half + play-from + play-until) — the same four fields, now five
    // underlying elements since the datetime-local field split in two.
    const dateTags = inputsOfType(html, "date");
    const selectTags = html.match(/<select[^>]*>/g) ?? [];
    expect(dateTags).toHaveLength(2);
    expect(selectTags).toHaveLength(3);
    // React emits `disabled=""` for true and nothing for false, so the `=""`
    // is load-bearing: `disabled` alone also matches a className.
    for (const tag of [...dateTags, ...selectTags]) expect(tag).toContain('disabled=""');
  });
});
