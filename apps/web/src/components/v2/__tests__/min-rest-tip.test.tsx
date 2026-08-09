// "Minimum rest" is editable on TWO tabs and stores TWO different values —
// `config.perEntrantMinRest` (Settings) and `config.constraints.restMin`
// (Constraints). The engine resolves them with MAX, never precedence
// (`effectiveRestMinutes`, packages/engine/src/scheduling/calendar.ts, #459),
// so nothing is broken underneath — but the losing field looked broken: type
// 10 beside a 30 and nothing changes, with nothing on screen saying why.
//
// One shared `Tip` now explains it on both fields. These pin the three things
// that can silently rot:
//   1. BOTH panels render it, from the SAME tip id, so the two tabs cannot
//      drift into two different explanations of one rule;
//   2. the copy exists in all four locales and keeps its worked example
//      (the numbers are what make the rule concrete);
//   3. the ⓘ is NOT inside a <label> — `Tip` renders a <button>, and a button
//      inside a label forwards its click to the control, so the tip would
//      focus/step the number input instead of opening. That is the reason both
//      rows were converted from a wrapping <label> to an explicit `htmlFor`.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ConstraintsPanel } from "../constraints-panel";
import { StandaloneScheduleSettings } from "@/components/v2/board/settings-panel";
import { DictProvider } from "@/components/i18n/dict-provider";
import { TIPS } from "@/config/tips";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";
import type { Dict, Locale } from "@/lib/i18n-constants";
import type { BoardConfig } from "@/components/v2/board/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

// `useConfirm` THROWS outside its provider (the context default is null) and
// this harness has no provider tree. Same mock the sibling blackout-editor
// suite uses; nothing asserted here goes through a confirm.
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => async () => true,
}));

const ORG_TZ = "Europe/London";
const TIP_ID = "schedule.min-rest";

const DICTS: [Locale, Dict][] = [
  ["en", enUi as Dict],
  ["es", esUi as Dict],
  ["fr", frUi as Dict],
  ["nl", nlUi as Dict],
];

const boardConfig: BoardConfig = {
  courts: ["Court 1"],
  matchMinutes: 30,
  gapMinutes: 0,
  perEntrantMinRest: 0,
  blackouts: [],
  sessionWindows: [],
  startAt: null,
  endAt: null,
} as unknown as BoardConfig;

const renderConstraints = (dict: Dict, locale: Locale) =>
  renderToStaticMarkup(
    <DictProvider dict={dict} locale={locale}>
      <ConstraintsPanel
        divisionId="d1"
        initialSettings={{ division_id: "d1", config: { courts: ["Court 1"], matchMinutes: 30, gapMinutes: 0 } }}
        canEdit
        orgTz={ORG_TZ}
      />
    </DictProvider>,
  );

const renderSettings = (dict: Dict, locale: Locale) =>
  renderToStaticMarkup(
    <DictProvider dict={dict} locale={locale}>
      <StandaloneScheduleSettings
        divisionId="d1"
        config={boardConfig}
        canEdit
        constraintsAllowed
        venueCap="Court"
        orgTz={ORG_TZ}
      />
    </DictProvider>,
  );

/** Every `<label>…</label>` region in the markup, innermost-first. A nested
 *  label cannot occur here, so a non-greedy scan is exact enough. */
const labelRegions = (html: string) => html.match(/<label[^>]*>[\s\S]*?<\/label>/g) ?? [];

/** React escapes text nodes; the fr/nl bodies contain apostrophes, which come
 *  out as `&#x27;`. Comparing raw dictionary strings against markup silently
 *  fails for exactly those locales. */
const escapeHtml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The rest-minutes `<input>`, found by the one thing unique to it in either
 *  panel: it is the only control wired with `aria-describedby`. Parsed rather
 *  than matched against a literal id so the assertions pin the RELATIONSHIP —
 *  label→input, input→hint — and stay honest if either id is ever renamed. */
const restInput = (html: string) => {
  const tags = html.match(/<input\b[^>]*aria-describedby="[^"]*"[^>]*>/g) ?? [];
  expect(tags, "expected exactly one input wired with aria-describedby").toHaveLength(1);
  // `?? ""` only to satisfy noUncheckedIndexedAccess — the length assertion
  // above is the real gate, and an empty tag fails every caller anyway.
  const tag = tags[0] ?? "";
  return {
    id: tag.match(/\bid="([^"]+)"/)?.[1] ?? "",
    describedBy: (tag.match(/\baria-describedby="([^"]+)"/)?.[1] ?? "").split(/\s+/).filter(Boolean),
  };
};

describe("minimum rest — one shared tip across both tabs", () => {
  it("is registered once, and the registry entry carries the worked example", () => {
    expect(TIPS).toHaveProperty(TIP_ID);
    // The example numbers ARE the explanation — "the stricter wins" alone
    // leaves an organiser guessing which of their two values is in force.
    expect(TIPS[TIP_ID].body).toMatch(/30/);
    expect(TIPS[TIP_ID].body).toMatch(/10/);
  });

  for (const [locale, dict] of DICTS) {
    it(`renders on BOTH tabs from the same tip id, in ${locale}`, () => {
      const title = dict[`tips.${TIP_ID}.title`] as string;
      const body = dict[`tips.${TIP_ID}.body`] as string;
      expect(title, `${locale} is missing tips.${TIP_ID}.title`).toBeTruthy();
      expect(body, `${locale} is missing tips.${TIP_ID}.body`).toBeTruthy();

      // Assert on the BUTTON'S ACCESSIBLE NAME, not the bare title, and not
      // the body. Two findings, both from mutation:
      //   * the body never appears in static markup at all — `Tip` renders its
      //     popover behind `{open && …}` (tip.tsx:62), so at rest only the
      //     button exists;
      //   * a bare title check is VACUOUS on the Settings tab, whose own field
      //     label is "Minimum rest per entrant (minutes)" — "Minimum rest" is a
      //     substring of it, so the assertion passed with no tip rendered.
      // `tips.about` ("About: {title}") is carried only by the tip button.
      const accessibleName = (dict["tips.about"] as string).replace("{title}", title);
      for (const [name, html] of [
        ["constraints", renderConstraints(dict, locale)],
        ["settings", renderSettings(dict, locale)],
      ] as const) {
        expect(html, `${name}/${locale} rendered no min-rest tip button`).toContain(
          escapeHtml(accessibleName),
        );
      }
      // The body is what the organiser actually reads — pinned at the registry
      // level below, since the markup cannot show it until opened.
      expect(body.length, `${locale} body is suspiciously short`).toBeGreaterThan(40);
    });

    it(`keeps the worked example in ${locale} — not translated away`, () => {
      // A translator paraphrasing "put 30 in one and 10 in the other" into
      // prose without numbers would leave the tip true but useless.
      const body = dict[`tips.${TIP_ID}.body`] as string;
      expect(body).toMatch(/30/);
      expect(body).toMatch(/10/);
    });
  }

  // The load-bearing structural assertion. This is what fails if someone
  // "tidies" either row back into a wrapping <label>.
  for (const [name, render] of [
    ["constraints", renderConstraints],
    ["settings", renderSettings],
  ] as const) {
    it(`${name}: the tip button sits OUTSIDE every <label>, association kept via htmlFor`, () => {
      const html = render(enUi as Dict, "en");

      // `Tip`'s button is the only thing here carrying aria-expanded.
      expect(html, "no tip button rendered at all").toMatch(/aria-expanded=/);
      for (const region of labelRegions(html)) {
        expect(
          region,
          `${name}: a tip button is nested inside a <label> — its click will be forwarded to the control`,
        ).not.toMatch(/aria-expanded=/);
      }

      // Association must still be real, not merely absent-by-restructure: the
      // rest input carries an id and a label points at it.
      const { id } = restInput(html);
      expect(id, `${name}: the rest input has no id to associate`).toBeTruthy();
      expect(html).toMatch(new RegExp(`<label[^>]*for="${reEsc(id)}"`));
    });

    // Splitting the wrapping <label> to host the tip took the hint (and, on
    // the Constraints tab, the "min" unit) OUT of the input's accessible name.
    // They are re-attached as a DESCRIPTION. An aria-describedby pointing at an
    // id that does not exist is silently empty, so resolve every reference.
    it(`${name}: the hint is re-attached via aria-describedby, and resolves`, () => {
      const html = render(enUi as Dict, "en");
      const { describedBy } = restInput(html);
      expect(describedBy.length, `${name}: nothing described`).toBeGreaterThan(0);

      for (const ref of describedBy) {
        const el = html.match(new RegExp(`<span[^>]*\\bid="${reEsc(ref)}"[^>]*>([\\s\\S]*?)</span>`));
        expect(el, `${name}: aria-describedby points at #${ref}, absent from the markup`).toBeTruthy();
        // Present but empty is the same failure with a nicer shape.
        expect(el![1].replace(/<[^>]*>/g, "").trim(), `${name}: #${ref} is empty`).not.toBe("");
      }

      // The hint text itself must be one of the things described — not merely
      // some other span that happens to carry the id.
      const hintKey = name === "constraints" ? "constraints.restMin.hint" : "boardset.restHint";
      const hint = (enUi as Dict)[hintKey] as string;
      const described = describedBy
        .map((ref) => html.match(new RegExp(`<span[^>]*\\bid="${reEsc(ref)}"[^>]*>([\\s\\S]*?)</span>`))?.[1] ?? "")
        .join(" ");
      expect(described, `${name}: the hint is not among the described text`).toContain(
        escapeHtml(hint),
      );
    });
  }

  it("constraints: the rest row's own copy comes from the dictionary, not hardcoded English", () => {
    // These three strings were hardcoded English in this panel before the tip
    // landed. Spanish is the cheapest proof they now resolve.
    const es = esUi as Dict;
    const html = renderConstraints(es, "es");
    expect(html).toContain(es["constraints.restMin.label"] as string);
    expect(html).toContain(es["constraints.restMin.hint"] as string);
    // ...and the English is genuinely gone from the Spanish render.
    expect(html).not.toContain("Breathing room between one entrant");
  });
});
