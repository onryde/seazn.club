// The /start wizard island driven step by step the way a browser would (start-wizard redesign, plan 2026-11-13 Task 4):
// B1 Sport → B2 Size and format → B3 Date → B4 Email → Sent, in every locale, through the real island and its real model,
// with only the network call and the Turnstile widget stood in (apps/web vitest has no DOM: _hook-harness.tsx supplies
// React's hooks). What it pins that the model test cannot: the island WIRES the model — each control dispatches what it
// shows, the body that reaches the network is the one the organiser built, and every word on every step is in the page's
// own dictionary (the dictionary stub throws on a key the locale lacks, so an English fallback cannot hide a gap).
//
// Expected values: words are the dictionary files on disk; the body's fields are what this test typed; the badge and the
// cards are T1's `rankFormats` / `bestFitSlug` / `funnelFormatMin`; dates are Intl's in the locale.
const net = vi.hoisted(() => ({
  calls: [] as { url: string; method?: string; json?: Record<string, unknown> }[],
  response: undefined as unknown,
  rejection: null as unknown,
}));
const words = vi.hoisted(() => ({ locale: "en" as string, dict: {} as Record<string, unknown> }));

vi.mock("@/lib/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client")>();
  return {
    ...actual,
    api: (url: string, options?: { method?: string; json?: Record<string, unknown> }) => {
      net.calls.push({ url, method: options?.method, json: options?.json });
      if (net.rejection) {
        const e = net.rejection;
        net.rejection = null;
        return Promise.reject(e);
      }
      return Promise.resolve(net.response);
    },
  };
});
vi.mock("@/components/turnstile-widget", () => ({
  useTurnstile: () => ({ token: () => Promise.resolve(null), reset: () => {} }),
  TurnstileWidget: function TurnstileWidgetStub() {
    return null;
  },
}));
vi.mock("@/components/i18n/dict-provider", async () => {
  const { interpolate } = await import("@/lib/i18n-runtime");
  // STRICT: a key the locale's dictionary lacks throws (never the English fallback), naming the locale.
  const look = (key: string): string => {
    const v = words.dict[key];
    if (typeof v !== "string") throw new Error(`${words.locale}: no dictionary entry for ${key}`);
    return v;
  };
  const t = (key: string, vars?: Record<string, string | number>) => interpolate(look(key), vars ?? {});
  const plural = (key: string, count: number, vars?: Record<string, string | number>) => {
    look(`${key}.other`);
    const cat = new Intl.PluralRules(words.locale).select(count);
    return interpolate(look(`${key}.${cat}`), { count, ...vars });
  };
  return {
    useT: () => t,
    useMsg: () => t,
    usePlural: () => plural,
    useLocale: () => words.locale,
    useLocaleOrDefault: () => words.locale,
  };
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { ApiError } from "@/lib/client";
import { bestFitSlug, rankFormats, type RankedFormat } from "@/lib/format-recommend";
import { FUNNEL_FORMATS, FUNNEL_MORE_FORMATS, funnelFormatMin } from "@/lib/funnel-formats";
import { FUNNEL_SPORTS, funnelSportMatchMinutes } from "@/lib/funnel-sports";
import { LOCALES, type Locale } from "@/lib/i18n-constants";
import { parseStartPrefill } from "@/app/[lang]/(marketing)/start/prefill";
import { CountStepper, StartWizard, type StartWizardProps } from "../start-wizard";

const TODAY = "2026-11-12"; // a Thursday
const evt = { preventDefault: () => {} };
const MAIN: readonly string[] = FUNNEL_FORMATS;

const readDict = (locale: Locale, file: "ui" | "marketing"): Record<string, unknown> =>
  JSON.parse(readFileSync(resolve(import.meta.dirname, "../../dictionaries", locale, `${file}.json`), "utf8")) as Record<string, unknown>;
/** What the real page provides: the marketing catalogue with `ui` merged over it. */
const pageDict = (locale: Locale) => ({ ...readDict(locale, "marketing"), ...readDict(locale, "ui") });
/** A dictionary sentence with its slots filled — read from the file, never from the island. */
const w = (key: string, vars: Record<string, string | number> = {}) => {
  const raw = words.dict[key];
  if (typeof raw !== "string") throw new Error(`test: ${words.locale} has no ${key}`);
  return Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), raw);
};
const sportWord = (key: string) => w(FUNNEL_SPORTS.find((s) => s.key === key)!.module === "generic" ? "start.wizard.sportOther" : `sport.${key}`);
const matchMinutes = (key: string) => funnelSportMatchMinutes(FUNNEL_SPORTS.find((s) => s.key === key)!);

type Island = ReturnType<typeof renderIsland<StartWizardProps>>;
const all = (island: Island) => island.tree();
const step = (island: Island) => propsOf(all(island).find((e) => propsOf(e)["data-step"] !== undefined)!)["data-step"];
const submit = async (island: Island) => {
  const form = all(island).find((e) => e.type === "form");
  expect(form, "the step's form").toBeTruthy();
  await (propsOf(form!).onSubmit as (e: typeof evt) => unknown)(evt);
};
const radios = (island: Island, name: string) => all(island).filter((e) => e.type === "input" && propsOf(e).type === "radio" && propsOf(e).name === name);
const radio = (island: Island, name: string, value: string) => {
  const found = radios(island, name).find((e) => propsOf(e).value === value);
  expect(found, `radio ${name}=${value}`).toBeTruthy();
  return found!;
};
const input = (island: Island, type: string) => {
  const found = all(island).find((e) => e.type === "input" && propsOf(e).type === type);
  expect(found, `an input type=${type}`).toBeTruthy();
  return found!;
};
const steppers = (island: Island) => all(island).filter((e) => e.type === CountStepper);
const buttonByText = (island: Island, text: string) => {
  const found = all(island).find((e) => e.type === "button" && textOf(e).includes(text));
  expect(found, `button "${text}"`).toBeTruthy();
  return found!;
};
const nextButton = (island: Island) => all(island).find((e) => e.type === "button" && propsOf(e).type === "submit")!;
const click = (el: ReactElement) => (propsOf(el).onClick as () => void)();
const change = (el: ReactElement, value: string) => (propsOf(el).onChange as (e: { target: { value: string } }) => void)({ target: { value } });
const cardsOf = (island: Island) => all(island).filter((e) => typeof e.type === "function" && e.type.name === "FormatCard");
const slugOf = (el: ReactElement) => (propsOf(el).card as RankedFormat).slug;
const card = (island: Island, slug: string) => {
  const found = cardsOf(island).find((c) => slugOf(c) === slug);
  expect(found, `card ${slug}`).toBeTruthy();
  return found!;
};
const pick = (island: Island, slug: string) => (propsOf(card(island, slug)).onPick as () => void)();
const stepLine = (n: number, key: string) => w("start.wizard.stepOf", { n, total: 4, label: w(`start.wizard.steps.${key}`) });

function mount(props: Partial<StartWizardProps> & { search?: Record<string, string> } = {}): Island {
  const { search = {}, ...rest } = props;
  return renderIsland(StartWizard, {
    initial: parseStartPrefill(search, TODAY),
    maxEntrants: 64,
    today: TODAY,
    playSports: ["tabletennis", "badminton"],
    ...rest,
  });
}

/** B1 → B4 on the defaults, picking League when nothing is chosen (a size where nothing fits shuts Next). */
async function toEmail(island: Island) {
  await submit(island);
  expect(step(island)).toBe("size");
  if (!cardsOf(island).some((c) => propsOf(c).checked)) pick(island, "league");
  await submit(island);
  expect(step(island)).toBe("date");
  await submit(island);
  expect(step(island)).toBe("email");
}

beforeEach(() => {
  net.calls = [];
  net.response = { message: "Check your email — your competition is one click away." };
  net.rejection = null;
});

describe("the wizard, B1 → Sent, in every locale", () => {
  it("walks every step through its own controls, words each from the page's dictionary, and posts what was built", async () => {
    let checked = 0;
    for (const locale of LOCALES) {
      words.locale = locale;
      words.dict = pageDict(locale);
      net.calls = [];
      const island = mount({ search: { sport: "tabletennis" } });

      // B1 — the link's sport is chosen; every funnel sport is a chip worded in this locale.
      expect(step(island), locale).toBe("sport");
      expect(island.text()).toContain(stepLine(1, "sport"));
      expect(island.text()).toContain(w("start.wizard.q.sport"));
      expect(propsOf(radio(island, "sport", "tabletennis")).checked).toBe(true);
      expect(radios(island, "sport").filter((e) => propsOf(e).checked), "one chip chosen").toHaveLength(1);
      expect(radios(island, "sport")).toHaveLength(FUNNEL_SPORTS.length);
      for (const sport of FUNNEL_SPORTS) expect(island.text(), `${locale} ${sport.key}`).toContain(sportWord(sport.key));
      const nameField = all(island).find((e) => e.type === "input" && propsOf(e).placeholder !== undefined)!;
      expect(propsOf(nameField).placeholder, "the default name is the sport's").toBe(w("start.wizard.compNameDefault", { sport: sportWord("tabletennis") }));
      change(nameField, "Harbour Vale Open");
      await submit(island);

      // B2 — 100 asked on a 64 cap: the hint, and the cards count the 64 the claim will build.
      expect(step(island)).toBe("size");
      expect(island.text()).toContain(stepLine(2, "size"));
      (propsOf(steppers(island)[0]!).onValue as (n: number) => void)(100);
      expect(island.text()).toContain(w("start.wizard.capHint", { cap: 64 }));
      const at64 = rankFormats({ entrants: 64, courts: 2, hours: 4, matchMinutes: matchMinutes("tabletennis") });
      const best = bestFitSlug(at64);
      // Unpicked, the selection follows Best fit; Double elimination stays behind More formats unless it IS that pick.
      expect(cardsOf(island).map((c) => propsOf(c).card)).toEqual(at64.filter((c) => MAIN.includes(c.slug) || c.slug === best));
      expect(cardsOf(island).filter((c) => propsOf(c).best).map(slugOf), "Best fit only on T1's pick").toEqual(best === null ? [] : [best]);
      expect(cardsOf(island).filter((c) => propsOf(c).checked).map(slugOf), "the selection is the Best fit").toEqual(best === null ? [] : [best]);
      for (const c of cardsOf(island)) {
        const p = propsOf(c) as { card: RankedFormat; name: string; tagline: string; tag: string; bestLabel: string };
        expect(p.name).toBe(w(`format.template.${p.card.slug === "groups-knockout" ? "groups_ko" : p.card.slug}.label`));
        expect(p.tagline).toBe(w(`format.${p.card.slug}.tagline`));
        expect(p.tag).toBe(p.card.fits ? w("start.wizard.fits") : w("start.wizard.runsOver"));
        expect(p.bestLabel).toBe(w("start.wizard.bestFit"));
      }
      if (best !== "double_elim") click(buttonByText(island, w("start.wizard.moreFormats")));
      expect(cardsOf(island).map(slugOf)).toEqual([...FUNNEL_FORMATS, ...FUNNEL_MORE_FORMATS]);
      expect(all(island).some((e) => e.type === "button" && textOf(e).includes(w("start.wizard.moreFormats"))), "More formats folds away").toBe(false);
      // Courts and time: opening it shows two more steppers and the promise-free planning line.
      expect(island.text()).not.toContain(w("start.wizard.planningNote"));
      click(buttonByText(island, w("start.wizard.planning")));
      expect(steppers(island)).toHaveLength(3);
      expect(island.text()).toContain(w("start.wizard.planningNote"));
      (propsOf(steppers(island)[1]!).onValue as (n: number) => void)(3);
      pick(island, "knockout");
      expect(cardsOf(island).filter((c) => propsOf(c).checked).map(slugOf)).toEqual(["knockout"]);
      // The badge is T1's Best fit of the cards on screen (3 courts now), not the organiser's own pick.
      const at64c3 = rankFormats({ entrants: 64, courts: 3, hours: 4, matchMinutes: matchMinutes("tabletennis") });
      const best3 = bestFitSlug(at64c3);
      expect(best3, "premise: the badge and the pick differ here").not.toBe("knockout");
      expect(cardsOf(island).filter((c) => propsOf(c).best).map(slugOf)).toEqual(best3 === null ? [] : [best3]);
      await submit(island);

      // B3 — three day chips in this locale's words, Pick a date opens the box (min = today), a chip closes it.
      expect(step(island)).toBe("date");
      expect(island.text()).toContain(stepLine(3, "date"));
      expect(radios(island, "date").map((e) => propsOf(e).value)).toEqual(["2026-11-14", "2026-11-15", "2026-11-21", "pick", "none"]);
      expect(propsOf(radio(island, "date", "none")).checked, "no date yet").toBe(true);
      const fmt = new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
      for (const d of ["2026-11-14", "2026-11-15", "2026-11-21"]) expect(island.text()).toContain(fmt.format(new Date(`${d}T00:00:00Z`)));
      expect(all(island).some((e) => e.type === "input" && propsOf(e).type === "date"), "no box before Pick a date").toBe(false);
      (propsOf(radio(island, "date", "pick")).onChange as () => void)();
      expect(propsOf(input(island, "date")).min).toBe(TODAY);
      change(input(island, "date"), "2026-12-05");
      expect(propsOf(input(island, "date")).value).toBe("2026-12-05");
      (propsOf(radio(island, "date", "2026-11-14")).onChange as () => void)();
      expect(all(island).some((e) => e.type === "input" && propsOf(e).type === "date"), "the box closes on a chip").toBe(false);
      expect(propsOf(radio(island, "date", "2026-11-14")).checked).toBe(true);
      await submit(island);

      // B4 — a bad address refused in place, worded, with no request.
      expect(step(island)).toBe("email");
      expect(island.text()).toContain(stepLine(4, "email"));
      change(input(island, "email"), "sam@harbourvale");
      await submit(island);
      expect(net.calls, `${locale}: nothing sent for a bad address`).toHaveLength(0);
      expect(island.text()).toContain(w("start.wizard.emailMissingTld"));
      change(input(island, "email"), "x");
      await submit(island);
      expect(island.text()).toContain(w("start.wizard.emailInvalid"));
      expect(net.calls).toHaveLength(0);
      change(input(island, "email"), "  sam@harbourvale.org ");
      await submit(island);

      // What reached the network: exactly what this walk built (D6 keys; Planning opened, so courts and hours ride).
      expect(net.calls).toHaveLength(1);
      expect(net.calls[0]).toMatchObject({ url: "/api/funnel/start", method: "POST" });
      expect(net.calls[0]!.json).toEqual({
        email: "sam@harbourvale.org",
        locale,
        name: "Harbour Vale Open",
        sport: "Table Tennis",
        entrants: 100,
        start_date: "2026-11-14",
        format: "knockout",
        courts: 3,
        hours: 4,
      });

      // Sent (A4) — the dictionary's words, never the server's English message.
      expect(step(island)).toBe("sent");
      expect(all(island).filter((e) => propsOf(e)["data-funnel-done"] !== undefined)).toHaveLength(1);
      expect(island.text()).toContain(w("start.wizard.checkEmail"));
      expect(island.text()).toContain("sam@harbourvale.org");
      expect(island.text()).not.toContain("one click away");
      const playLink = all(island).find((e) => propsOf(e)["data-testid"] === "start-play-link");
      expect(propsOf(playLink!).href).toBe(`/${locale}/play?sport=tabletennis`);
      expect(textOf(playLink!)).toBe(w("start.wizard.quickMatchLink"));
      // "Wrong address? Change it" — back to B4 with every answer kept; the second send carries the new address only.
      click(buttonByText(island, w("start.wizard.changeIt")));
      expect(step(island)).toBe("email");
      change(input(island, "email"), "sam@harbourvale.com");
      await submit(island);
      expect(net.calls).toHaveLength(2);
      expect(net.calls[1]!.json).toEqual({ ...net.calls[0]!.json, email: "sam@harbourvale.com" });
      expect(step(island)).toBe("sent");
      checked++;
    }
    expect(checked).toBe(LOCALES.length);
  });

  it("Back walks one step at a time and keeps every answer", async () => {
    words.locale = "fr";
    words.dict = pageDict("fr");
    const island = mount({ search: { sport: "football", entrants: "12" } });
    await toEmail(island);
    for (const want of ["date", "size", "sport"]) {
      click(buttonByText(island, w("start.wizard.back")));
      expect(step(island)).toBe(want);
    }
    expect(all(island).some((e) => e.type === "button" && textOf(e).includes(w("start.wizard.back"))), "B1 has no Back").toBe(false);
    expect(propsOf(radio(island, "sport", "football")).checked).toBe(true);
    await submit(island);
    expect(propsOf(steppers(island)[0]!).value, "the size is kept").toBe(12);
  });
});

describe("the wizard's edges", () => {
  beforeEach(() => {
    words.locale = "en";
    words.dict = pageDict("en");
  });

  it("nothing fits: no card wears Best fit, nothing is chosen, Next is shut until League is picked", async () => {
    expect(bestFitSlug(rankFormats({ entrants: 40, courts: 2, hours: 4, matchMinutes: matchMinutes("badminton") })), "premise").toBeNull();
    const island = mount({ search: { entrants: "40" } });
    await submit(island);
    expect(cardsOf(island).length).toBeGreaterThan(0);
    expect(cardsOf(island).filter((c) => propsOf(c).best)).toHaveLength(0);
    expect(cardsOf(island).filter((c) => propsOf(c).checked)).toHaveLength(0);
    expect(propsOf(nextButton(island)).disabled).toBe(true);
    await submit(island);
    expect(step(island), "a submit past a shut Next stays put").toBe("size");
    pick(island, "league");
    expect(propsOf(nextButton(island)).disabled).toBe(false);
    await submit(island);
    expect(step(island)).toBe("date");
  });

  it("something fits: Best fit and the selection land on T1's pick; the organiser's own pick moves the selection, not the badge", async () => {
    const island = mount({ search: { sport: "badminton", entrants: "12" } });
    await submit(island);
    click(buttonByText(island, w("start.wizard.planning")));
    (propsOf(steppers(island)[1]!).onValue as (n: number) => void)(4);
    (propsOf(steppers(island)[2]!).onValue as (n: number) => void)(6);
    const best = bestFitSlug(rankFormats({ entrants: 12, courts: 4, hours: 6, matchMinutes: matchMinutes("badminton") }));
    expect(best, "premise: something fits at 12 on 4 courts in 6 hours").not.toBeNull();
    expect(cardsOf(island).filter((c) => propsOf(c).best).map(slugOf)).toEqual([best]);
    expect(cardsOf(island).filter((c) => propsOf(c).checked).map(slugOf)).toEqual([best]);
    const other = best === "league" ? "knockout" : "league";
    pick(island, other);
    expect(cardsOf(island).filter((c) => propsOf(c).checked).map(slugOf)).toEqual([other]);
    expect(cardsOf(island).filter((c) => propsOf(c).best).map(slugOf), "the badge stays on Best fit").toEqual([best]);
    // A later size change does not take the organiser's pick away.
    (propsOf(steppers(island)[0]!).onValue as (n: number) => void)(10);
    expect(cardsOf(island).filter((c) => propsOf(c).checked).map(slugOf)).toEqual([other]);
  });

  it("a card below its minimum is disabled, cannot be picked, and says what it needs", async () => {
    const island = mount({ search: { entrants: "3" } });
    await submit(island);
    const gk = card(island, "groups-knockout");
    expect((propsOf(gk).card as RankedFormat).available).toBe(false);
    expect(propsOf(gk).tag).toBe(w("start.wizard.needsAtLeast", { min: funnelFormatMin("groups-knockout") }));
    pick(island, "groups-knockout");
    expect(propsOf(card(island, "groups-knockout")).checked).toBe(false);
  });

  it("the cap line shows only over the cap; an unlimited plan has none at any size", async () => {
    let checked = 0;
    for (const [entrants, maxEntrants, shown] of [
      ["16", 64, false],
      ["64", 64, false],
      ["65", 64, true],
      ["200", null, false],
    ] as const) {
      const island = mount({ search: { entrants }, maxEntrants });
      await submit(island);
      expect(all(island).filter((e) => propsOf(e).id === "start-cap-hint"), `${entrants} on ${maxEntrants}`).toHaveLength(shown ? 1 : 0);
      expect(propsOf(steppers(island)[0]!).describedBy).toBe(shown ? "start-cap-hint" : undefined);
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("a sport /play does not offer gets no quick match link on Sent", async () => {
    const island = mount({ search: { sport: "cricket" } });
    await toEmail(island);
    change(input(island, "email"), "sam@harbourvale.org");
    await submit(island);
    expect(step(island)).toBe("sent");
    expect(all(island).some((e) => propsOf(e)["data-testid"] === "start-play-link")).toBe(false);
    expect(net.calls[0]!.json!.sport, "cricket posts its catalogue name").toBe("Cricket");
    expect(net.calls[0]!.json, "Planning never opened: no courts or hours").not.toHaveProperty("courts");
    expect(net.calls[0]!.json).not.toHaveProperty("hours");
  });

  it("a refused send shows the wizard's own sentence (429: wait; anything else: try again), never the server's, and stays on B4", async () => {
    let checked = 0;
    for (const [rejection, key] of [
      [new ApiError("Too many requests", 429, "RATE_LIMITED"), "start.wizard.tooMany"],
      [new ApiError("Internal server error", 500, "ERROR"), "start.wizard.genericError"],
      [new TypeError("Failed to fetch"), "start.wizard.genericError"],
    ] as const) {
      const island = mount();
      await toEmail(island);
      change(input(island, "email"), "sam@harbourvale.org");
      net.rejection = rejection;
      await submit(island);
      expect(step(island)).toBe("email");
      expect(island.text()).toContain(w(key));
      expect(island.text()).not.toContain(rejection.message);
      expect(propsOf(nextButton(island)).disabled, "the send button comes back").toBe(false);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("the dev claim link shows only when the route returned one", async () => {
    for (const [response, want] of [
      [{ message: "x", claim_url: "http://localhost/start/claim?token=t" }, 1],
      [{ message: "x" }, 0],
    ] as const) {
      net.response = response;
      const island = mount();
      await toEmail(island);
      change(input(island, "email"), "sam@harbourvale.org");
      await submit(island);
      expect(all(island).filter((e) => propsOf(e)["data-claim-url"] !== undefined)).toHaveLength(want);
    }
  });
});

describe("the count box (CountStepper)", () => {
  beforeEach(() => {
    words.locale = "en";
    words.dict = pageDict("en");
  });
  const box = (island: { tree: () => ReactElement[] }) => island.tree().find((e) => e.type === "input")!;

  it("typing reaches the wizard only as a count; a cleared box keeps the last count and shows it again on blur", () => {
    const seen: number[] = [];
    const island = renderIsland(CountStepper, { labelId: "x", label: "Players", value: 16, bounds: { min: 2, max: 256 }, onValue: (n: number) => void seen.push(n) });
    change(box(island), "");
    expect(seen, "a cleared box is no count").toEqual([]);
    expect(propsOf(box(island)).value, "the box shows what was typed").toBe("");
    change(box(island), "1");
    expect(seen, "a lone low digit is not sent").toEqual([]);
    change(box(island), "12");
    expect(seen).toEqual([12]);
    change(box(island), "300");
    expect(seen, "above the top reads as the top").toEqual([12, 256]);
    (propsOf(box(island)).onBlur as () => void)();
    expect(propsOf(box(island)).value, "blur shows the count the wizard holds").toBe("16");
  });

  it("− and + step within the bounds, are worded per control, and are disabled at the ends", () => {
    const seen: number[] = [];
    const at = (value: number) =>
      renderIsland(CountStepper, { labelId: "x", label: "Courts", value, bounds: { min: 1, max: 32 }, onValue: (n: number) => void seen.push(n) });
    const [less, more] = at(1).tree().filter((e) => e.type === "button");
    expect(propsOf(less!).disabled).toBe(true);
    expect(propsOf(more!).disabled).toBe(false);
    expect(propsOf(less!)["aria-label"]).toBe(w("start.wizard.stepper.less", { label: "Courts" }));
    expect(propsOf(more!)["aria-label"]).toBe(w("start.wizard.stepper.more", { label: "Courts" }));
    click(more!);
    expect(seen).toEqual([2]);
    const [down, top] = at(32).tree().filter((e) => e.type === "button");
    expect(propsOf(top!).disabled).toBe(true);
    click(down!);
    expect(seen).toEqual([2, 31]);
  });
});
