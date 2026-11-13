// /play's quiet door to a season (owner 2026-11-13, quick-match-decision-log.md: "Or register to start a season"; start
// wizard plan 2026-11-13 Task 5). Under the Start, a link to the organiser's /start wizard carrying the sport the chips have
// chosen, so the wizard opens on it.
//
// Both ends of the seam are real: the producer is the island's own mount (QuickMatchSetupForm driven through
// `renderIsland`, its chips clicked as a browser would) and the link's own href; the consumer is /start's parser
// (`parseStartPrefill`, start-wizard plan Task 3), which every link into /start goes through. Expected sports come from the
// quick match offer's generated file (the probe's output, which `listQuickMatchSports` reads) and from the parser, never
// from the link under test; the words come from the four dictionaries.
//
// Sport: every sport the offer lists (swept), plus keys the funnel does not list; the island drives four sports (two kinds,
// one kind, team, a non-first preferred variant), as setup-form.test.tsx does.
vi.mock("@/components/turnstile-widget", () => {
  const controller = { token: () => Promise.resolve(null), reset() {}, awaitingVisitor: () => false, reveal() {} };
  return { useTurnstile: () => controller, TurnstileWidget: () => null };
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import enMarketing from "@/dictionaries/en/marketing.json";
import enUi from "@/dictionaries/en/ui.json";
import esMarketing from "@/dictionaries/es/marketing.json";
import esUi from "@/dictionaries/es/ui.json";
import frMarketing from "@/dictionaries/fr/marketing.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlMarketing from "@/dictionaries/nl/marketing.json";
import nlUi from "@/dictionaries/nl/ui.json";
import offerJson from "@/lib/quick-match-offer.generated.json";
import { LOCALES, type Locale } from "@/lib/i18n-constants";
import { quickMatchPreviewTable } from "@/server/usecases/quick-match-preview";
import type { QuickMatchSport } from "@/server/usecases/quick-match-sports";
import { propsOf, renderIsland, walk } from "@/components/__tests__/_hook-harness";
import { setupCopy, setupSports } from "@/app/[lang]/(marketing)/play/setup-props";
import { parseStartPrefill } from "@/app/[lang]/(marketing)/start/prefill";
import { QuickMatchSetupForm, type SetupFormProps } from "../setup-form";
import { RegisterSeasonLink, startHrefForSport } from "../register-season-link";

const KEY = "quickMatch.setup.registerSeason";
const DICTS: Record<Locale, { marketing: Record<string, unknown>; ui: Record<string, unknown> }> = {
  en: { marketing: enMarketing, ui: enUi },
  es: { marketing: esMarketing, ui: esUi },
  fr: { marketing: frMarketing, ui: frUi },
  nl: { marketing: nlMarketing, ui: nlUi },
};
const words = (lang: Locale) => DICTS[lang].marketing[KEY] as string;

/** Every sport the /play chips (and the hero's select, which lists the same offer) can emit: the offer file's sports. */
const OFFERED_KEYS = [...new Set(offerJson.offered.map((o) => o.sport_key))];
/** Any calendar day: a sport's prefill does not depend on it. */
const TODAY = "2026-11-13";

/** The link as /start reads it: its path, its query's names, and the sport the wizard opens on. */
function arrival(href: string) {
  const url = new URL(href, "https://seazn.test");
  return {
    path: url.pathname,
    params: [...url.searchParams.keys()],
    sport: parseStartPrefill(Object.fromEntries(url.searchParams), TODAY).sportKey,
  };
}

/** listQuickMatchSports' shape (labelKey = real dictionary keys), catalog order: badminton first, then three that are not. */
const OFFER: QuickMatchSport[] = [
  {
    sport_key: "badminton",
    labelKey: "sport.badminton",
    kinds: ["individual", "pair"],
    variants: [{ variant_key: "bwf", labelKey: "variant.badminton.bwf", knockoutAllowed: true }],
  },
  {
    sport_key: "boardgame",
    labelKey: "sport.boardgame",
    kinds: ["individual"],
    variants: [{ variant_key: "rapid", labelKey: "variant.boardgame.rapid", knockoutAllowed: true }],
  },
  {
    sport_key: "football",
    labelKey: "sport.football",
    kinds: ["team"],
    variants: [{ variant_key: "11-a-side", labelKey: "variant.football.elevenASide", knockoutAllowed: true }],
  },
  {
    sport_key: "tennis",
    labelKey: "sport.tennis",
    kinds: ["individual", "pair"],
    variants: [
      { variant_key: "fast4", labelKey: "variant.tennis.fast4", knockoutAllowed: true },
      { variant_key: "tour", labelKey: "variant.tennis.tour", knockoutAllowed: true },
    ],
  },
];

function props(lang: Locale, over: Partial<SetupFormProps> = {}): SetupFormProps {
  const sports = setupSports(OFFER, DICTS[lang].ui);
  if (sports.length !== OFFER.length) throw new Error("the fixture offer lost a sport");
  return {
    lang,
    sports: sports as SetupFormProps["sports"],
    table: quickMatchPreviewTable(),
    copy: setupCopy(DICTS[lang].marketing, DICTS[lang].ui),
    initialError: null,
    ...over,
  };
}
const mount = (lang: Locale = "en", over: Partial<SetupFormProps> = {}) =>
  renderIsland(QuickMatchSetupForm, props(lang, over), undefined, { hydrate: true });
type Island = ReturnType<typeof mount>;

/** The door the island mounts: exactly one, and its props. */
function door(i: Island) {
  const found = i.tree().filter((el) => el.type === RegisterSeasonLink);
  expect(found, "the island mounts one door to a season").toHaveLength(1);
  return propsOf(found[0]!) as { lang: string; sportKey: string; label: string };
}
function chooseSport(i: Island, key: string) {
  const chip = i
    .tree()
    .find((el) => el.type === "input" && propsOf(el).name === "sport_key" && propsOf(el).value === key);
  if (!chip) throw new Error(`no ${key} chip`);
  (propsOf(chip).onChange as (e: unknown) => void)({ target: { value: key, checked: true } });
}
const byTestId = (i: Island, id: string) => i.tree().find((el) => propsOf(el)["data-testid"] === id);
/** An element's own children, flattened as React flattens them (arrays, fragments of none). */
const kidsOf = (el: ReactElement) => [propsOf(el).children as ReactNode].flat(3).filter((c): c is ReactElement => !!c && typeof c === "object");

beforeEach(() => {
  vi.stubGlobal("window", { location: { assign: vi.fn() }, addEventListener() {}, removeEventListener() {} });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the door's href: /start with the sport, or plain /start", () => {
  it("the empty case first: no sport, or a blank one, is plain `/<lang>/start` (the wizard opens on its own default)", () => {
    let checked = 0;
    for (const raw of [null, undefined, "", "   "]) {
      expect(startHrefForSport("en", raw), JSON.stringify(raw)).toBe("/en/start");
      expect(arrival(startHrefForSport("en", raw)).sport).toBeNull();
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("a key /start does not take is never sent: plain `/<lang>/start`, so the link carries nothing its reader drops", () => {
    // Premise: each of these is refused by the reader itself, so a link sending it would land on the default anyway.
    const refused = ["quidditch", "generic", "<img src=x onerror=alert(1)>", "../badminton", "badminton;drop"];
    let checked = 0;
    for (const raw of refused) {
      expect(parseStartPrefill({ sport: raw }, TODAY).sportKey, `premise: /start drops ${raw}`).toBeNull();
      expect(startHrefForSport("en", raw), raw).toBe("/en/start");
      checked++;
    }
    expect(checked).toBe(refused.length);
  });

  it("a sport given by its NAME is sent as its key (the docstring's \"by key or name, sent as its key\")", () => {
    // The sports table's display names (start wizard plan N6 / T1's FUNNEL_SPORTS), typed here with the key each names:
    // a name with a space or a different word from its key is the case a raw pass-through would get wrong.
    const named: readonly (readonly [string, string])[] = [
      ["Table Tennis", "tabletennis"],
      ["table tennis", "tabletennis"],
      ["Ice Hockey", "icehockey"],
      ["Chess", "boardgame"],
    ];
    let checked = 0;
    for (const [name, key] of named) {
      expect(startHrefForSport("en", name), name).toBe(`/en/start?sport=${key}`);
      expect(arrival(startHrefForSport("en", name)).sport, `${name}: /start opens on ${key}`).toBe(key);
      checked++;
    }
    expect(checked).toBe(named.length);
  });

  it("every sport the chips can emit round-trips: /start opens on it, in every language, with `sport` the only param", () => {
    let checked = 0;
    for (const lang of LOCALES) {
      for (const key of OFFERED_KEYS) {
        const a = arrival(startHrefForSport(lang, key));
        expect(a, `${lang} ${key}`).toEqual({ path: `/${lang}/start`, params: ["sport"], sport: key });
        checked++;
      }
    }
    // Anti-vacuity, and a differential: more than one sport, so a door stuck on one cannot pass.
    expect(OFFERED_KEYS.length, "the offer lists sports").toBeGreaterThanOrEqual(2);
    expect(checked, "locale x sport checked").toBe(LOCALES.length * OFFERED_KEYS.length);
  });

  it("renders a quiet 44px link with the words it is given", () => {
    const html = renderToStaticMarkup(<RegisterSeasonLink lang="es" sportKey="football" label={words("es")} />);
    const a = html.match(/<a\b[^>]*>/)?.[0];
    expect(a, "one link").toBeDefined();
    expect(html.match(/<a\b/g)).toHaveLength(1);
    expect(a).toContain('href="/es/start?sport=football"');
    expect(a).toContain('data-testid="qm-register-season"');
    expect(a).toMatch(/\bclass="[^"]*\bmin-h-11\b/);
    expect(html).toContain(`>${words("es")}</a>`);
  });
});

describe("the island mounts the door on the sport the chips have chosen", () => {
  it("opens on the offer's first, or the `?sport=` the page read, and follows every chip, there and back", () => {
    expect(door(mount()).sportKey, "no ?sport=: the offer's first").toBe(OFFER[0]!.sport_key);
    expect(door(mount("en", { initialSport: "football" })).sportKey, "the page's ?sport=").toBe("football");
    const i = mount();
    let checked = 0;
    for (const s of [...OFFER.slice(1), OFFER[0]!]) {
      chooseSport(i, s.sport_key);
      const d = door(i);
      expect(d.sportKey, s.sport_key).toBe(s.sport_key);
      expect(arrival(startHrefForSport(d.lang, d.sportKey)).sport, `${s.sport_key} reaches /start`).toBe(s.sport_key);
      checked++;
    }
    expect(checked).toBe(OFFER.length);
  });

  it("speaks the page's language: each locale's own words and path, never English elsewhere", () => {
    let checked = 0;
    for (const lang of LOCALES) {
      const d = door(mount(lang));
      expect(typeof words(lang), `${lang} has the key`).toBe("string");
      expect(d.label, lang).toBe(words(lang));
      expect(d.lang).toBe(lang);
      if (lang !== "en") expect(d.label, `${lang} is translated`).not.toBe(words("en"));
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("sits after the Start zone, a child of the form: never inside the Start bar that docks to a phone's foot", () => {
    const i = mount();
    const form = i.tree().find((el) => el.type === "form")!;
    const zone = byTestId(i, "qm-start-zone")!;
    const bar = byTestId(i, "qm-start-bar")!;
    expect(zone, "the Start zone").toBeDefined();
    expect(bar, "the Start bar").toBeDefined();
    const isDoor = (el: ReactElement) => el.type === RegisterSeasonLink;
    expect(walk(propsOf(bar).children as ReactNode).some(isDoor), "not in the bar").toBe(false);
    expect(walk(propsOf(zone).children as ReactNode).some(isDoor), "not in the zone").toBe(false);
    const kids = kidsOf(form);
    const at = kids.findIndex(isDoor);
    expect(at, "a child of the form").toBeGreaterThan(-1);
    expect(kids[at - 1], "straight after the Start zone").toBe(zone);
    expect(at, "the form's last child").toBe(kids.length - 1);
  });
});
