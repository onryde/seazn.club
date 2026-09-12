// The widened theme-component contract, driven through its REAL producer and
// its REAL consumer (AGENTS.md failure class 1 — "a seam is proven only by
// driving it through its REAL producer and consumer"; a fixture on both ends
// proves the fixture).
//
// The producer is `OverlayStage`, which owns the dictionary and the sport key
// and is the ONLY place a theme becomes a component. The consumer is
// `OverlaySlate`, the one shipped theme that needs both. Nothing here calls a
// theme with hand-written props: the stage builds `msg` from a REAL on-disk
// dictionary and the assertions read the HTML a viewer would be served.
//
// `environment: "node"`, no jsdom — `renderToStaticMarkup` is this directory's
// existing precedent for a real, non-mocked render of a hook-using client
// component (see overlay-stage-delay.test.tsx's own header).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { OverlayStage, type OverlayStageProps } from "../overlay-stage";
import { OVERLAY_THEMES, defaultThemeFor } from "../theme-registry";
import { decidedOutcomeTemplates } from "@/lib/scoring-vocab";
import { t } from "@/lib/i18n-runtime";
import type { OverlayLiveData } from "@/components/public-site/live-score-data";

const HERE = dirname(fileURLToPath(import.meta.url));
const DICT = join(HERE, "../../../dictionaries");
const LOCALES = ["en", "fr", "es", "nl"] as const;

const dictOf = (locale: string): Record<string, string> =>
  JSON.parse(readFileSync(join(DICT, locale, "public.json"), "utf8"));

const SCHEDULED: OverlayLiveData = {
  status: "scheduled",
  summary: null,
  outcome: null,
  lastSeq: 0,
  venueTz: "Europe/London",
};

function props(over: Partial<OverlayStageProps>): OverlayStageProps {
  return {
    fixtureId: "f1",
    initial: SCHEDULED,
    realtime: false,
    sportKey: "football",
    style: "slate",
    sides: [
      { id: "home", name: "Milton Keynes Rovers" },
      { id: "away", name: "Northbridge Athletic" },
    ],
    startLabel: "Sat 14:30 BST",
    dict: dictOf("en"),
    decidedTemplates: decidedOutcomeTemplates((k) => k),
    ...over,
  };
}

const headlineOf = (html: string): string => {
  const match = html.match(/data-testid="ovl-slate-headline"[^>]*>([^<]*)</);
  if (!match) throw new Error(`no slate headline in:\n${html}`);
  return match[1]!;
};

const lineOf = (html: string): string => {
  const match = html.match(/data-testid="ovl-slate-line"[^>]*>([^<]*)</);
  if (!match) throw new Error(`no slate line in:\n${html}`);
  return match[1]!;
};

// ---------------------------------------------------------------------------
// `msg` — the dictionary channel, threaded from the stage's own `dict`.
// ---------------------------------------------------------------------------
describe("OverlayStage threads its dictionary to the theme (`msg`)", () => {
  it.each(LOCALES)(
    "%s: the slate's warming headline served by the stage IS that locale's vs template",
    (locale) => {
      const html = renderToStaticMarkup(<OverlayStage {...props({ dict: dictOf(locale) })} />);
      expect(headlineOf(html)).toBe(
        t(dictOf(locale), "overlay.slate.warmingHeadlineVs", {
          home: "Milton Keynes Rovers",
          away: "Northbridge Athletic",
        }),
      );
    },
  );

  it("the same fixture in en and in fr serves DIFFERENT words — a hardcoded English literal fails this", () => {
    const en = renderToStaticMarkup(<OverlayStage {...props({ dict: dictOf("en") })} />);
    const fr = renderToStaticMarkup(<OverlayStage {...props({ dict: dictOf("fr") })} />);
    expect(dictOf("en")["overlay.slate.warmingHeadlineVs"], "premise").not.toBe(
      dictOf("fr")["overlay.slate.warmingHeadlineVs"],
    );
    expect(headlineOf(en)).not.toBe(headlineOf(fr));
  });

  it("the warming LINE is toss-pending + start — names live on the headline (A1)", () => {
    const html = renderToStaticMarkup(<OverlayStage {...props({})} />);
    const line = lineOf(html);
    expect(line).toContain("Sat 14:30 BST");
    expect(line, "an unsupplied var renders as `{name}`").not.toMatch(/\{[a-z]+\}/i);
    expect(headlineOf(html)).toContain("Milton Keynes Rovers");
    expect(headlineOf(html)).toContain("Northbridge Athletic");
  });

  it("no raw `overlay.slate.*` key reaches the served HTML — `t()` returns the key on a miss", () => {
    for (const locale of LOCALES) {
      const html = renderToStaticMarkup(<OverlayStage {...props({ dict: dictOf(locale) })} />);
      expect(html, locale).not.toMatch(/overlay\.slate\./);
    }
  });

  it("the dictionary the theme reads is the SAME one the model reads — one channel, not two", () => {
    // A dict that carries the slate keys but NOT the header key the model
    // needs: if the theme had its own second dictionary source, the slate
    // headline would resolve while the model's header did not (or vice
    // versa). Both must come out of `props.dict`.
    const en = dictOf("en");
    const partial: Record<string, string> = {
      "overlay.slate.warmingHeadlineVs": "ZZTOP {home} {away}",
      "overlay.slate.warmingLineTossPending": "TOSS|{start}",
      "overlay.brand": "seazn",
    };
    const html = renderToStaticMarkup(<OverlayStage {...props({ dict: partial })} />);
    expect(headlineOf(html), "the theme reads props.dict").toBe("ZZTOP Milton Keynes Rovers Northbridge Athletic");
    expect(lineOf(html)).toBe("TOSS|Sat 14:30 BST");
    expect(headlineOf(html), "not some other en dictionary").not.toBe(
      t(en, "overlay.slate.warmingHeadlineVs", {
        home: "Milton Keynes Rovers",
        away: "Northbridge Athletic",
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// `sportKey` — the composited scorebug is the SPORT'S default, not a constant.
// ---------------------------------------------------------------------------
describe("OverlayStage threads its sport key to the theme (`sportKey`)", () => {
  const SPORTS = [
    "cricket",
    "football",
    "hockey",
    "icehockey",
    "tennis",
    "badminton",
    "tabletennis",
    "volleyball",
    "boardgame",
    "carrom",
    "generic",
  ] as const;

  /** The root class the registry's chosen default renders — read off a
   *  standalone render of THAT component, never a table typed here, so a
   *  moved default moves this expectation with it. */
  const rootClassOfDefault = (sportKey: string): string => {
    const html = renderToStaticMarkup(
      <OverlayStage {...props({ sportKey, style: defaultThemeFor(sportKey) })} />,
    );
    const match = html.match(/<div class="(ovl-[a-z]+)"/);
    if (!match) throw new Error(`no theme root in:\n${html}`);
    return match[1]!;
  };

  it.each(SPORTS)("slate on %s composites exactly the theme defaultThemeFor names", (sportKey) => {
    const expected = rootClassOfDefault(sportKey);
    const html = renderToStaticMarkup(<OverlayStage {...props({ sportKey })} />);
    expect(html, `${sportKey} should composite ${defaultThemeFor(sportKey)} ("${expected}")`).toContain(
      `class="${expected}"`,
    );
  });

  it("cricket composites the BAR and football the BUG — the differential a hardcoded OverlayBug fails", () => {
    expect(defaultThemeFor("cricket"), "premise").not.toBe(defaultThemeFor("football"));
    const cricket = renderToStaticMarkup(<OverlayStage {...props({ sportKey: "cricket" })} />);
    const football = renderToStaticMarkup(<OverlayStage {...props({ sportKey: "football" })} />);
    expect(cricket).toContain('class="ovl-bar"');
    expect(cricket).not.toContain('class="ovl-bug"');
    expect(football).toContain('class="ovl-bug"');
    expect(football).not.toContain('class="ovl-bar"');
  });

  it("no sport defaults to slate — the composite would otherwise recurse forever", () => {
    for (const sportKey of SPORTS) {
      expect(defaultThemeFor(sportKey), sportKey).not.toBe("slate");
      expect(OVERLAY_THEMES[defaultThemeFor(sportKey)].component, sportKey).not.toBe(
        OVERLAY_THEMES.slate.component,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The widening is INVISIBLE to the two themes that do not use it (§3's bar and
// §4's bug render byte-identically to before).
// ---------------------------------------------------------------------------
describe("bar and bug are unmoved by the widened contract", () => {
  it.each(["bar", "bug"] as const)(
    "%s renders BYTE-IDENTICALLY whether or not the dictionary carries the slate copy",
    (style) => {
      // Two dictionaries that differ ONLY in the keys the new `msg` channel
      // exists for. Bar and bug read neither, so their bytes must not move —
      // and the SLATE differential above proves the same pair of dicts really
      // does change what a theme that DOES read them renders.
      const withSlate = dictOf("en");
      const withoutSlate = Object.fromEntries(
        Object.entries(withSlate).filter(([k]) => !k.startsWith("overlay.slate.")),
      );
      const a = renderToStaticMarkup(<OverlayStage {...props({ style, dict: withSlate })} />);
      const b = renderToStaticMarkup(<OverlayStage {...props({ style, dict: withoutSlate })} />);
      expect(a).toBe(b);
      expect(a).toContain(`class="ovl-${style}"`);
    },
  );

  it("the slate, on the SAME pair of dictionaries, does move — so the check above is not vacuous", () => {
    const withSlate = dictOf("en");
    const withoutSlate = Object.fromEntries(
      Object.entries(withSlate).filter(([k]) => !k.startsWith("overlay.slate.")),
    );
    const a = renderToStaticMarkup(<OverlayStage {...props({ style: "slate", dict: withSlate })} />);
    const b = renderToStaticMarkup(<OverlayStage {...props({ style: "slate", dict: withoutSlate })} />);
    expect(a).not.toBe(b);
  });

  it.each(["bar", "bug"] as const)("%s renders BYTE-IDENTICALLY for two different sportKeys", (style) => {
    // Both are `sports: "all"` and neither branches on the sport in JS (the
    // palette arrives as CSS custom properties on the ancestor `.ovl-canvas`,
    // which the stage sets — outside the theme's own subtree).
    const subtree = (html: string) => html.slice(html.indexOf(`<div class="ovl-${style}"`));
    const cricket = renderToStaticMarkup(<OverlayStage {...props({ style, sportKey: "cricket" })} />);
    const football = renderToStaticMarkup(<OverlayStage {...props({ style, sportKey: "football" })} />);
    expect(subtree(cricket)).toBe(subtree(football));
  });
});
