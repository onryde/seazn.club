// Four controls raise the minimum-rest floor and the strictest silently wins.
// `min-rest-tip.test.tsx` beside this one pins the TIP, which explains the rule
// in the abstract. This pins the NOTE, which does the organiser's arithmetic for
// them: it names the control actually in charge and prints the resulting number.
//
// Three things here can silently rot, and each has assertions of its own:
//   1. The note appears only when a DIFFERENT control outranks the one it sits
//      beside. A note that always renders is noise, and a note that never
//      renders is the bug this change exists to fix — so both directions are
//      asserted, not just the visible one.
//   2. `noBackToBack` — a checkbox, not a number — resolves to
//      `matchMinutes + gapMinutes` and routinely outranks both numeric fields.
//      That is the interaction nothing on screen used to admit to.
//   3. The copy is real in all four locales. Asserting only the English render
//      would pass with three untranslated copies of it, so the non-English
//      renders are asserted to DIFFER from English.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RestFloorNote } from "../rest-floor-note";
import { ConstraintsPanel } from "../constraints-panel";
import { StandaloneScheduleSettings } from "@/components/v2/board/settings-panel";
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

// `useConfirm` THROWS outside its provider (the context default is null) and
// this harness has no provider tree — same mock the sibling suites use.
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => async () => true,
}));

const ORG_TZ = "Europe/London";

const DICTS: [Locale, Dict][] = [
  ["en", enUi as Dict],
  ["es", esUi as Dict],
  ["fr", frUi as Dict],
  ["nl", nlUi as Dict],
];

/** `id` is supplied here rather than by each caller: these cases are about WHEN
 *  the note speaks and WHAT it says, and the id only matters where a panel
 *  wires it into `aria-describedby` — which has its own describe block below. */
const note = (
  props: Omit<Parameters<typeof RestFloorNote>[0], "id">,
  dict: Dict = enUi as Dict,
  locale: Locale = "en",
) =>
  renderToStaticMarkup(
    <DictProvider dict={dict} locale={locale}>
      <RestFloorNote id="probe-rest-floor" {...props} />
    </DictProvider>,
  );

/** The rendered note's `source`, or null when the note stayed silent. Anchored
 *  on `="` deliberately: React serialises an omitted prop as `"$undefined"`, so
 *  a bare `data-rest-floor-source` probe would match in both states. */
const sourceOf = (html: string) => html.match(/data-rest-floor-source="([^"$][^"]*)"/)?.[1] ?? null;

const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

describe("RestFloorNote — when it speaks and when it stays quiet", () => {
  it("names the Constraints tab when its restMin outranks the Settings field", () => {
    const html = note({
      field: "perEntrantMinRest",
      config: { perEntrantMinRest: 10, matchMinutes: 30, gapMinutes: 0, constraints: { restMin: 30 } },
    });
    expect(sourceOf(html)).toBe("restMin");
    expect(text(html)).toContain("30");
  });

  it("names the Settings tab when its value outranks the Constraints field", () => {
    const html = note({
      field: "restMin",
      config: { perEntrantMinRest: 45, matchMinutes: 30, gapMinutes: 0, constraints: { restMin: 10 } },
    });
    expect(sourceOf(html)).toBe("perEntrantMinRest");
    expect(text(html)).toContain("45");
  });

  // The other direction. Without this the component could render unconditionally
  // and every assertion above would still pass.
  it("stays silent beside the control that is setting the floor", () => {
    const html = note({
      field: "perEntrantMinRest",
      config: { perEntrantMinRest: 30, matchMinutes: 30, gapMinutes: 0, constraints: { restMin: 10 } },
    });
    expect(html).toBe("");
  });

  it("stays silent when no rule demands any rest", () => {
    const html = note({
      field: "restMin",
      config: { perEntrantMinRest: 0, matchMinutes: 30, gapMinutes: 0, constraints: { restMin: 0 } },
    });
    expect(html).toBe("");
  });

  // The surprising one: a checkbox two rows below the number outranks it.
  it("names the no-back-to-back checkbox, and shows match + gap as the floor", () => {
    const html = note({
      field: "restMin",
      config: {
        perEntrantMinRest: 10,
        matchMinutes: 30,
        gapMinutes: 5,
        constraints: { restMin: 30, noBackToBack: true },
      },
    });
    expect(sourceOf(html)).toBe("noBackToBack");
    expect(text(html)).toContain("35");
  });

  // Neither panel knows which pool a given entrant is in, so neither passes a
  // group and a `restByGroup` entry cannot win here. It must not leak into the
  // number either — quoting 60 to an organiser who has 20 set, for a floor that
  // applies to one pool, would be worse than saying nothing.
  it("does not pick up a per-pool override it has no entrant to resolve", () => {
    const html = note({
      field: "perEntrantMinRest",
      config: {
        perEntrantMinRest: 10,
        matchMinutes: 30,
        gapMinutes: 0,
        constraints: { restMin: 20, restByGroup: { "pool-a": 60 } },
      },
    });
    expect(sourceOf(html)).toBe("restMin");
    expect(text(html)).toContain("20");
    expect(text(html), "the pool override leaked into the headline number").not.toContain("60");
  });
});

describe("RestFloorNote — the copy is real in all four locales", () => {
  const props = {
    field: "perEntrantMinRest",
    config: { perEntrantMinRest: 10, matchMinutes: 30, gapMinutes: 0, constraints: { restMin: 30 } },
  } as const;

  const english = text(note(props));

  it.each(DICTS)("%s renders a non-empty note carrying the number", (locale, dict) => {
    const rendered = text(note(props, dict, locale));
    expect(rendered, `${locale}: note is empty`).not.toBe("");
    expect(rendered, `${locale}: lost the resolved floor`).toContain("30");
    // The key must not leak through as its own fallback.
    expect(rendered, `${locale}: raw key rendered`).not.toContain("restFloor.");
  });

  it.each(DICTS.filter(([l]) => l !== "en"))("%s is actually translated, not English", (locale, dict) => {
    expect(text(note(props, dict, locale)), `${locale} is byte-identical to English`).not.toBe(
      english,
    );
  });
});

// Review caught this gap, no test did: the note rendered as a bare <span> that
// neither input's `aria-describedby` named, so a screen-reader user tabbing to
// the field heard the hint and the unit but not the one line explaining why
// their number is being ignored. The sibling hint/unit spans were already in
// the described set. The same area shipped a real a11y regression one round
// earlier, so it gets assertions in BOTH directions.
describe("RestFloorNote — the described set tracks the note", () => {
  /** Every id the input claims to be described by, in order. Anchored on `="`
   *  because React serialises an omitted prop as `"$undefined"`. */
  const describedBy = (html: string, inputId: string) =>
    (html
      .match(new RegExp(`<input[^>]*\\bid="${inputId}"[^>]*>`))?.[0]
      .match(/aria-describedby="([^"]*)"/)?.[1] ?? "")
      .split(/\s+/)
      .filter(Boolean);

  const settings = (config: Partial<BoardConfig>) =>
    renderToStaticMarkup(
      <DictProvider dict={enUi as Dict} locale="en">
        <StandaloneScheduleSettings
          divisionId="d1"
          config={{
            courts: ["Court 1"],
            matchMinutes: 30,
            gapMinutes: 0,
            perEntrantMinRest: 10,
            blackouts: [],
            sessionWindows: [],
            startAt: null,
            endAt: null,
            ...config,
          } as unknown as BoardConfig}
          canEdit
          constraintsAllowed
          venueCap="Court"
          orgTz={ORG_TZ}
          viewerPlan="community"
        />
      </DictProvider>,
    );

  it("names the note when it renders, and every named id resolves", () => {
    const html = settings({ constraints: { restMin: 45 } } as Partial<BoardConfig>);
    const ids = describedBy(html, "boardset-rest");
    expect(ids, "the note is not in the described set").toContain("boardset-rest-floor");
    for (const id of ids) {
      const el = html.match(new RegExp(`<span[^>]*\\bid="${id}"[^>]*>([\\s\\S]*?)</span>`));
      expect(el, `aria-describedby names #${id}, which is absent from the markup`).toBeTruthy();
      expect(el![1].replace(/<[^>]*>/g, "").trim(), `#${id} is empty`).not.toBe("");
    }
  });

  // The other half. A dangling `aria-describedby` is worse than none: assistive
  // tech resolves nothing and the hint is announced as if complete.
  it("drops the note from the described set when it does not render", () => {
    const html = settings({ perEntrantMinRest: 45, constraints: { restMin: 10 } } as Partial<BoardConfig>);
    expect(html).not.toContain('id="boardset-rest-floor"');
    expect(describedBy(html, "boardset-rest")).not.toContain("boardset-rest-floor");
  });
});

describe("RestFloorNote — reaches both panels", () => {
  const boardConfig = {
    courts: ["Court 1"],
    matchMinutes: 30,
    gapMinutes: 0,
    perEntrantMinRest: 10,
    blackouts: [],
    sessionWindows: [],
    startAt: null,
    endAt: null,
    constraints: { restMin: 45 },
  } as unknown as BoardConfig;

  it("the Settings tab reports the Constraints tab's stricter value", () => {
    const html = renderToStaticMarkup(
      <DictProvider dict={enUi as Dict} locale="en">
        <StandaloneScheduleSettings
          divisionId="d1"
          config={boardConfig}
          canEdit
          constraintsAllowed
          venueCap="Court"
          orgTz={ORG_TZ}
          viewerPlan="community"
        />
      </DictProvider>,
    );
    expect(sourceOf(html)).toBe("restMin");
    expect(text(html)).toContain("45");
  });

  it("the Constraints tab reports the Settings tab's stricter value", () => {
    const html = renderToStaticMarkup(
      <DictProvider dict={enUi as Dict} locale="en">
        <ConstraintsPanel
          divisionId="d1"
          initialSettings={{
            division_id: "d1",
            config: {
              courts: ["Court 1"],
              matchMinutes: 30,
              gapMinutes: 0,
              perEntrantMinRest: 45,
              constraints: { restMin: 10 },
            },
          }}
          canEdit
          orgTz={ORG_TZ}
          viewerPlan="community"
        />
      </DictProvider>,
    );
    expect(sourceOf(html)).toBe("perEntrantMinRest");
    expect(text(html)).toContain("45");
  });
});
