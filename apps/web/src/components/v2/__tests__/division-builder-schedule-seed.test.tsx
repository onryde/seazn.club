import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DivisionBuilder, buildScheduleSeed } from "@/components/v2/division-builder";
import { msg } from "@/lib/messages";
import { DictProvider } from "@/components/i18n/dict-provider";
import uiEn from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";

// Regression: the creation wizard's Scheduling step seeds schedule-settings
// right after create. Two ways that seed used to be lost silently —
//   1. the fallback venue was the hardcoded "Court 1", not the sport's noun;
//   2. a >1 venue list trips usesConstraints() server-side, which 402s the
//      WHOLE settings PUT for a Community org — so match length, start and end
//      date were discarded too, with the wizard's `catch {}` hiding it.
// The wizard now gates the venue list behind the Pro feature AND retries the
// seed with a single venue if the first PUT fails.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/o/org/c/comp/d/new",
}));

const SPORTS = [
  { key: "football", name: "Football", variants: [{ key: "standard", name: "Standard", system: true }] },
];

function render(constraintsAllowed: boolean): string {
  return renderToStaticMarkup(
    <DictProvider dict={uiEn as unknown as Dict} locale="en">
      <DivisionBuilder
        competitionId="c1"
        orgSlug="org"
        compSlug="comp"
        sports={SPORTS}
        constraintsAllowed={constraintsAllowed}
      />
    </DictProvider>,
  );
}

describe("buildScheduleSeed — wizard schedule-settings seed", () => {
  const input = {
    courts: ["Pitch 1", "  Pitch 2  ", "  "],
    matchMinutes: 90,
    startAt: "2026-08-01T10:00",
    endAt: "2026-08-03",
    venueCap: "Pitch",
  };

  it("trims the venue list and converts the local inputs to ISO", () => {
    const seed = buildScheduleSeed(input);
    expect(seed.courts).toEqual(["Pitch 1", "Pitch 2"]);
    expect(seed.matchMinutes).toBe(90);
    expect(seed.startAt).toBe(new Date("2026-08-01T10:00").toISOString());
    expect(seed.endAt).toBe(new Date("2026-08-03T23:59:00").toISOString());
  });

  it("falls back to the SPORT's venue noun, not a hardcoded Court 1", () => {
    expect(buildScheduleSeed({ ...input, courts: ["", "   "] }).courts).toEqual(["Pitch 1"]);
  });

  it("singleVenue keeps dates + match length while dropping the extra venues", () => {
    // The retry after a 402: everything the organiser typed survives except
    // the part the plan actually gates.
    const seed = buildScheduleSeed(input, { singleVenue: true });
    expect(seed.courts).toEqual(["Pitch 1"]);
    expect(seed.matchMinutes).toBe(90);
    expect(seed.startAt).not.toBeNull();
    expect(seed.endAt).not.toBeNull();
  });

  it("leaves unset dates null (a blank scheduling step is still valid)", () => {
    const seed = buildScheduleSeed({ ...input, startAt: "", endAt: "" });
    expect(seed.startAt).toBeNull();
    expect(seed.endAt).toBeNull();
  });

  it("treats a DATE-ONLY start as unset, never as midnight", () => {
    // The competition-window prefill seeds the start field with the
    // competition's opening DAY and no time — a bare `YYYY-MM-DD`, which is
    // what `splitValue`/`joinValue` already treat as a half-filled pair.
    // Storing it would invent a time-of-day the organiser never chose, and
    // `new Date("2026-08-01")` is midnight UTC rather than midnight on the
    // venue clock: for a venue west of UTC that instant lands on the previous
    // day and the seed PUT 422s against its own competition's opening date —
    // a refusal this wizard deliberately swallows, so it would vanish.
    const seed = buildScheduleSeed({ ...input, startAt: "2026-08-01" });
    expect(seed.startAt).toBeNull();
    // The END field is a date input, so a bare date there is COMPLETE and
    // still becomes that day's last minute — unchanged.
    expect(seed.endAt).toBe(new Date("2026-08-03T23:59:00").toISOString());
  });
});

describe("DivisionBuilder — scheduling step date/time controls", () => {
  // Regression for the date/time UX programme, prompt 02. The Scheduling step
  // carried two hand-rolled native controls (`<input type="datetime-local">`
  // and `<input type="date">`, each in its own `<label className="block">`).
  // They now go through the shared `DateTimeField`, so all six date/time call
  // sites in the app share one control.
  //
  // Rewritten for the quarter-hour picker
  // (docs/superpowers/specs/2026-08-10-quarter-hour-time-select-design.md):
  // Chrome's clock POPUP ignores `step` (measured, Chrome 151), so
  // `kind="datetime-local"` (the start field) is no longer one
  // `<input type="datetime-local">` — `DateTimeSplitField` renders a date
  // `<input>` beside a time `<select>` instead, joined back into the same
  // string. `kind="date"` (the end field) is unchanged.
  //
  // The observable fingerprint is still the class. Hand-rolled was
  // `input w-full`; DateTimeField renders `input w-full text-base` on BOTH
  // the date input and the select (see its own suite for why `text-base` and
  // not `text-base sm:text-sm`). apps/web has no jsdom, so the rendered
  // markup is the only place a shared child is visible from here.
  // React escapes text nodes, so a dictionary sentence with `&` or `'` in it
  // ("Start date & time") is never a raw substring of the markup.
  const escapeHtml = (s: string): string =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#x27;");
  const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  /** The `<input type="date">` immediately preceded by one field's own
   *  visible label — disambiguates the start field's date HALF from the end
   *  field's own (bare) date input, since both are now `type="date"`. */
  const dateInputAfterLabel = (html: string, labelText: string): string => {
    const found = new RegExp(`<span class="label">${escapeRe(labelText)}</span><input[^>]*type="date"[^>]*>`).exec(
      html,
    );
    if (!found) throw new Error(`no <input type="date"> labelled "${labelText}" in the wizard markup`);
    return found[0];
  };

  it("renders schedule start and end through the shared DateTimeField", () => {
    const html = render(true);
    const startLabel = escapeHtml(msg("boardset.startAt"));
    const endLabel = escapeHtml(msg("boardset.endAt"));
    const timeLabel = escapeRe(escapeHtml(msg("datetime.timeLabel")));

    // The visible label immediately precedes each date input — pairing
    // intact for both the start field's date half and the end field.
    expect(html).toMatch(new RegExp(`<span class="label">${escapeRe(startLabel)}</span><input[^>]*type="date"`));
    expect(html).toMatch(new RegExp(`<span class="label">${escapeRe(endLabel)}</span><input[^>]*type="date"`));
    // The start field's HIDDEN label precedes its time select instead — same
    // pairing rule, for the half that names itself "Time" beside it.
    expect(html).toMatch(
      new RegExp(`<span class="label sr-only">${escapeRe(startLabel)}</span><select[^>]*aria-label="${timeLabel}"`),
    );

    // Exactly two date inputs (start's date half + end) and one time select
    // (start's time half): end stays a bare date, never gains a pair.
    const dateTags = html.match(/<input[^>]*type="date"[^>]*>/g) ?? [];
    const timeSelects = html.match(new RegExp(`<select[^>]*aria-label="${timeLabel}"[^>]*>`, "g")) ?? [];
    expect(dateTags).toHaveLength(2);
    expect(timeSelects).toHaveLength(1);
    for (const tag of [...dateTags, ...timeSelects]) {
      expect(tag).toContain('class="input w-full text-base"');
    }

    // The end-date hint still follows the END field's date input specifically.
    expect(html).toMatch(
      new RegExp(
        `<span class="label">${escapeRe(endLabel)}</span><input[^>]*type="date"[^>]*>.*${escapeRe(escapeHtml(msg("wizard.endDateHint")))}`,
        "s",
      ),
    );
  });

  it("emits no min on the end date while the start is unset", () => {
    // `min` is derived from the start value and handed to DateTimeField as a
    // prop; an always-present `min=""` would make every date unselectable.
    // (DateTimeField's own suite red-proves that it forwards a set `min`.)
    // Targeted at the END field specifically — the start field's own date
    // half is never given a `min` at all, which would pass vacuously.
    const html = render(true);
    expect(dateInputAfterLabel(html, escapeHtml(msg("boardset.endAt")))).not.toContain("min=");
  });
});

describe("DivisionBuilder — venue list gate", () => {
  it("offers Add venue when the org has scheduling.constraints", () => {
    const html = render(true);
    expect(html).toContain(msg("boardset.addVenue", { venue: "pitch" }));
    expect(html).not.toContain(msg("wizard.venuesProHint", { venue: "pitch" }));
  });

  it("replaces Add venue with the Pro hint + upgrade gate without the feature", () => {
    const html = render(false);
    expect(html).not.toContain(msg("boardset.addVenue", { venue: "pitch" }));
    expect(html).toContain(msg("wizard.venuesProHint", { venue: "pitch" }));
    // The same paywall component the schedule settings panel uses.
    expect(html).toContain("/settings/billing");
  });
});
