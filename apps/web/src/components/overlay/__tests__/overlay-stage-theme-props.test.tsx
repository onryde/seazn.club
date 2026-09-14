// The widened theme-component contract, driven through its REAL producer and
// its REAL consumer (AGENTS.md failure class 1 — "a seam is proven only by
// driving it through its REAL producer and consumer"; a fixture on both ends
// proves the fixture).
//
// The producer is `OverlayStage`, which owns the dictionary and the sport key
// and is the ONLY place a theme becomes a component. The match-card layer
// (`OverlayMatchCard`) is the consumer of `msg` while warming/ended. Nothing
// here calls a theme with hand-written props: the stage builds `msg` from a
// REAL on-disk dictionary and the assertions read the HTML a viewer would be
// served.
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
import { defaultThemeFor } from "../theme-registry";
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
    style: "bug",
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
// Scorebug under the match card — sport default is bar|bug, never slate.
// ---------------------------------------------------------------------------
describe("OverlayStage mounts scorebug + match card when scheduled", () => {
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

  const scorebugRootOf = (html: string): string => {
    const match = html.match(/<div class="(ovl-(?:bar|bug))"/);
    if (!match) throw new Error(`no scorebug root in:\n${html}`);
    return match[1]!;
  };

  it.each(SPORTS)("%s with style=default shows that sport's scorebug under the match card", (sportKey) => {
    const expected = `ovl-${defaultThemeFor(sportKey)}`;
    const html = renderToStaticMarkup(
      <OverlayStage {...props({ sportKey, style: defaultThemeFor(sportKey) })} />,
    );
    expect(scorebugRootOf(html), `${sportKey} scorebug`).toBe(expected);
    expect(html, "warming card layer").toContain('data-testid="ovl-slate-card"');
  });

  it("cricket bar + football bug — and both carry the match card when scheduled", () => {
    expect(defaultThemeFor("cricket"), "premise").not.toBe(defaultThemeFor("football"));
    const cricket = renderToStaticMarkup(
      <OverlayStage {...props({ sportKey: "cricket", style: "bar" })} />,
    );
    const football = renderToStaticMarkup(
      <OverlayStage {...props({ sportKey: "football", style: "bug" })} />,
    );
    expect(cricket).toContain('class="ovl-bar"');
    expect(cricket).not.toContain('class="ovl-bug"');
    expect(football).toContain('class="ovl-bug"');
    expect(football).not.toContain('class="ovl-bar"');
    expect(cricket).toContain('data-testid="ovl-slate-card"');
    expect(football).toContain('data-testid="ovl-slate-card"');
  });

  it("retired ?style=slate is not a ThemeId — page resolveTheme maps it before the stage", () => {
    // Stage props are ThemeId only; the page's resolveTheme maps "slate" → default.
    expect(defaultThemeFor("cricket")).toBe("bar");
    expect(defaultThemeFor("football")).toBe("bug");
  });
});

// ---------------------------------------------------------------------------
// Live: no match card, so bar/bug ignore overlay.slate.* dictionary keys.
// ---------------------------------------------------------------------------
describe("bar and bug ignore slate copy while LIVE (no match card)", () => {
  const LIVE: OverlayLiveData = {
    status: "in_play",
    summary: null,
    outcome: null,
    lastSeq: 1,
    venueTz: "Europe/London",
  };

  it.each(["bar", "bug"] as const)(
    "%s renders BYTE-IDENTICALLY whether or not the dictionary carries the slate copy",
    (style) => {
      const withSlate = dictOf("en");
      const withoutSlate = Object.fromEntries(
        Object.entries(withSlate).filter(([k]) => !k.startsWith("overlay.slate.")),
      );
      const a = renderToStaticMarkup(
        <OverlayStage {...props({ style, dict: withSlate, initial: LIVE })} />,
      );
      const b = renderToStaticMarkup(
        <OverlayStage {...props({ style, dict: withoutSlate, initial: LIVE })} />,
      );
      expect(a).toBe(b);
      expect(a).toContain(`class="ovl-${style}"`);
      expect(a).not.toContain('data-testid="ovl-slate-card"');
    },
  );

  it("the match card, on the SAME pair of dictionaries while scheduled, does move", () => {
    const withSlate = dictOf("en");
    const withoutSlate = Object.fromEntries(
      Object.entries(withSlate).filter(([k]) => !k.startsWith("overlay.slate.")),
    );
    const a = renderToStaticMarkup(<OverlayStage {...props({ style: "bar", dict: withSlate })} />);
    const b = renderToStaticMarkup(
      <OverlayStage {...props({ style: "bar", dict: withoutSlate })} />,
    );
    expect(a).not.toBe(b);
    expect(a).toContain("UPCOMING");
    expect(b).toContain("overlay.slate.pillUpcoming");
  });

  it.each(["bar", "bug"] as const)("%s scorebug subtree is BYTE-IDENTICAL for two sportKeys when live", (style) => {
    const subtree = (html: string) => html.slice(html.indexOf(`<div class="ovl-${style}"`));
    const cricket = renderToStaticMarkup(
      <OverlayStage {...props({ style, sportKey: "cricket", initial: LIVE })} />,
    );
    const football = renderToStaticMarkup(
      <OverlayStage {...props({ style, sportKey: "football", initial: LIVE })} />,
    );
    expect(subtree(cricket)).toBe(subtree(football));
  });
});
