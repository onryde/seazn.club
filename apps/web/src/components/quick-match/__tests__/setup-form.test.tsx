// The quick match setup island (plan 2 Task 4; spec docs/superpowers/specs/2026-11-03-quick-match-design.md §5 step 2,
// C16, C17, C22, C23; pre-flight amendments B4, C1, C3, D5, D6, D15, Q2; ledger carries "CARRY to T4").
//
// No DOM here (vitest `environment: "node"`): the island is driven through `renderIsland`, whose dispatcher runs its
// hooks, and its handlers are called as a browser would call them. Two real producers feed it, never a fixture:
//  - the server's precomputed table, `quickMatchPreviewTable()` (T2), so every count below is the generator's;
//  - the page's own copy and sport builders (`setupCopy`, `setupSports`) over the real en dictionaries, so a key the
//    page forgets to hand over shows up here as a raw key in an English assertion.
// Expected values come from the rulebook (spec C6, §7.3: a league is plays × n(n−1)/2 matches) and from T3's code table,
// never from the island. The format is a stacked list of three whole choices (plan 5 Task 6; spec 2026-11-12-quick-match-
// league-knockout §3, §12): League | League → Final (top 2) | League → Semi-finals → Final (top 4); a plain Knockout is not
// offered. A League + Knockout's count is the league's plus the knockout's q − 1 (a single-elimination draw of q sides plays
// q − 1 matches), and the mockup of record (qmd13a01 §6) gives 18, 33 and 4.
//
// Sport: the island sweeps four sports (badminton, chess, football, tennis): two kinds, one kind, team, and a sport whose
// preferred variant is not its first. The full live offer is swept against the real DB in play-page.test.tsx.
//
// The bot check (Cloudflare Turnstile, owner 2026-11-12): the widget is a stand-in with the controller's own surface
// (token/reset), as turnstile-surfaces-wiring.test.tsx stubs it, because the real widget needs a browser; the REAL
// `withTurnstile` runs, so what reaches the stubbed fetch is what the island sends. The controller's real half is
// lib/__tests__/turnstile-client.test.ts.
const turnstileFake = vi.hoisted(() => ({
  token: null as string | null,
  resets: 0,
  actions: [] as string[],
  /** The controller's `awaitingVisitor()`: an interactive challenge is on screen with no token yet. */
  awaiting: false,
  reveals: 0,
  controller: null as unknown as { token(): Promise<string | null>; reset(): void; awaitingVisitor(): boolean; reveal(): void },
}));
vi.mock("@/components/turnstile-widget", () => {
  turnstileFake.controller = {
    token: () => Promise.resolve(turnstileFake.token),
    reset: () => {
      turnstileFake.resets++;
    },
    awaitingVisitor: () => turnstileFake.awaiting,
    reveal: () => {
      turnstileFake.reveals++;
    },
  };
  return {
    useTurnstile: (action: string) => {
      turnstileFake.actions.push(action);
      return turnstileFake.controller;
    },
    TurnstileWidget: function TurnstileWidgetStub() {
      return null;
    },
  };
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import enMarketing from "@/dictionaries/en/marketing.json";
import enUi from "@/dictionaries/en/ui.json";
import esMarketing from "@/dictionaries/es/marketing.json";
import esUi from "@/dictionaries/es/ui.json";
import frMarketing from "@/dictionaries/fr/marketing.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlMarketing from "@/dictionaries/nl/marketing.json";
import nlUi from "@/dictionaries/nl/ui.json";
import { LOCALES } from "@/lib/i18n-constants";
import {
  QUICK_MATCH_EMAIL_PATTERN,
  QUICK_MATCH_ERRORS,
  QUICK_MATCH_MAX_PLAYS,
  QUICK_MATCH_MAX_SIDES,
  QUICK_MATCH_NAME_MAX,
  QUICK_MATCH_NON_BLANK_PATTERN,
  QUICK_MATCH_SIDE_NAME_MAX,
} from "@/lib/quick-match-constants";
import { CreateQuickMatch } from "@/server/api-v1/schemas";
import { quickMatchPreviewTable, type QuickMatchPreviewTable } from "@/server/usecases/quick-match-preview";
import type { QuickMatchSport } from "@/server/usecases/quick-match-sports";
import { propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";
import { prefillSport, setupCopy, setupSports } from "@/app/[lang]/(marketing)/play/setup-props";
import { CONSENT_OPEN_ATTR } from "@/components/cookie-consent";
import { TurnstileWidget } from "@/components/turnstile-widget";
import { compileClasses } from "@/components/v2/__tests__/_compiled-css";
import {
  QuickMatchSetupForm,
  matchCountOf,
  setupBody,
  setupErrorKey,
  submitOutcome,
  type SetupFormProps,
} from "../setup-form";

const TABLE = quickMatchPreviewTable();
const COPY = setupCopy(enMarketing, enUi);

/** listQuickMatchSports' shape, as plan 1 returns it (labelKey = real dictionary keys). Catalog (sport key) order. */
const OFFER: QuickMatchSport[] = [
  {
    sport_key: "badminton",
    labelKey: "sport.badminton",
    kinds: ["individual", "pair"],
    variants: [
      { variant_key: "bwf", labelKey: "variant.badminton.bwf", knockoutAllowed: true },
      { variant_key: "bwf-3x15", labelKey: "variant.badminton.bwf3x15", knockoutAllowed: true },
      { variant_key: "short", labelKey: "variant.badminton.short", knockoutAllowed: true },
    ],
  },
  {
    sport_key: "boardgame",
    labelKey: "sport.boardgame",
    kinds: ["individual"],
    variants: [
      { variant_key: "blitz", labelKey: "variant.boardgame.blitz", knockoutAllowed: true },
      { variant_key: "rapid", labelKey: "variant.boardgame.rapid", knockoutAllowed: true },
    ],
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

function props(over: Partial<SetupFormProps> = {}): SetupFormProps {
  const sports = setupSports(OFFER, enUi);
  if (sports.length === 0) throw new Error("fixture offer produced no sports");
  return { lang: "en", sports: sports as SetupFormProps["sports"], table: TABLE, copy: COPY, initialError: null, ...over };
}

type Island = ReturnType<typeof renderIsland<SetupFormProps>>;
const mount = (over: Partial<SetupFormProps> = {}, options: { hydrate?: boolean } = {}): Island =>
  renderIsland(QuickMatchSetupForm, props(over), undefined, options);

const all = (i: Island) => i.tree();
const inputs = (i: Island, name: string) => all(i).filter((el) => el.type === "input" && propsOf(el).name === name);
const sideInputs = (i: Island) => inputs(i, "sides");
const radio = (i: Island, name: string, value: string) =>
  inputs(i, name).find((el) => propsOf(el).type === "radio" && propsOf(el).value === value);
const hidden = (i: Island, name: string) => inputs(i, name).find((el) => propsOf(el).type === "hidden");
const byTestId = (i: Island, id: string) => all(i).find((el) => propsOf(el)["data-testid"] === id);
const buttonNamed = (i: Island, label: string) =>
  all(i).find((el) => el.type === "button" && (propsOf(el)["aria-label"] === label || textOf(el).trim() === label));
const start = (i: Island) => {
  const el = byTestId(i, "qm-start");
  if (!el) throw new Error("no Start button");
  return el;
};
const startText = (i: Island) => textOf(start(i)).replace(/\s+/g, " ").trim();
const nameInput = (i: Island) => {
  const el = inputs(i, "name")[0];
  if (!el) throw new Error("no name input");
  return el;
};
const emailInput = (i: Island) => {
  const el = inputs(i, "email")[0];
  if (!el) throw new Error("no email input");
  return el;
};
/** The fold the email field sits in: the one `<details>` holding the email input. */
const emailDetails = (i: Island) => {
  const found = all(i).filter((el) => el.type === "details" && walk(el).some((c) => c.type === "input" && propsOf(c).name === "email"));
  if (found.length !== 1) throw new Error(`expected one fold around the email field, found ${found.length}`);
  return found[0]!;
};

function type(el: ReactElement | undefined, value: string) {
  if (!el) throw new Error("typing into a control that is not there");
  (propsOf(el).onChange as (e: { target: { value: string; checked: boolean } }) => void)({ target: { value, checked: true } });
}
const click = (el: ReactElement | undefined) => {
  if (!el) throw new Error("clicking a control that is not there");
  (propsOf(el).onClick as () => void)();
};
function fillSides(i: Island, names: string[]) {
  while (sideInputs(i).length < names.length) click(buttonNamed(i, "+ Add a side"));
  names.forEach((n, k) => type(sideInputs(i)[k], n));
}
const submit = (i: Island) => (propsOf(all(i).find((el) => el.type === "form")!).onSubmit as (e: { preventDefault(): void }) => Promise<void>)({ preventDefault: () => {} });

/** The island's `window`: `location.assign` for a home, and the `pageshow` listener it adds on mount (m9). */
let pageListeners: Map<string, Set<(e: unknown) => void>>;
function stubWindow(assign: (path: string) => void = vi.fn()) {
  pageListeners = new Map();
  vi.stubGlobal("window", {
    location: { assign },
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      if (!pageListeners.has(type)) pageListeners.set(type, new Set());
      pageListeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: (e: unknown) => void) => pageListeners.get(type)?.delete(fn),
  });
}
const firePageshow = (persisted: boolean) => [...(pageListeners.get("pageshow") ?? [])].forEach((fn) => fn({ persisted }));

beforeEach(() => {
  stubWindow();
  turnstileFake.token = null;
  turnstileFake.resets = 0;
  turnstileFake.actions = [];
  turnstileFake.awaiting = false;
  turnstileFake.reveals = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---- the pure rules -----------------------------------------------------------------------------------------------

describe("matchCountOf: the Start button's number is a lookup in the server's table", () => {
  it("every league is plays × n(n−1)/2 (rulebook); 10 cells checked", () => {
    let checked = 0;
    for (let n = 2; n <= QUICK_MATCH_MAX_SIDES; n++) {
      for (let plays = 1; plays <= QUICK_MATCH_MAX_PLAYS; plays++) {
        expect(matchCountOf(TABLE, n, plays, "league"), `league ${n}×${plays}`).toBe((plays * n * (n - 1)) / 2);
        checked++;
      }
    }
    // 5 side counts (2..6) × 2 plays (Once, Twice).
    expect(checked).toBe(10);
  });

  it("a League + Knockout is the league's count plus q − 1 (single elimination); 14 cells checked", () => {
    // Final (q = 2) from 3 sides, Semi-finals (q = 4) from 4 (spec §3); both plays.
    let checked = 0;
    for (const [shape, q, from] of [["final", 2, 3], ["semis", 4, 4]] as const) {
      for (let n = from; n <= QUICK_MATCH_MAX_SIDES; n++) {
        for (let plays = 1; plays <= QUICK_MATCH_MAX_PLAYS; plays++) {
          expect(matchCountOf(TABLE, n, plays, shape), `${shape} ${n}×${plays}`).toBe((plays * n * (n - 1)) / 2 + (q - 1));
          checked++;
        }
      }
    }
    // Final: 4 side counts (3..6) × 2 plays; Semi-finals: 3 (4..6) × 2.
    expect(checked).toBe(14);
  });

  it("the mockup's numbers (qmd13a01 §6): 6 sides once + semis = 18, twice = 33; 3 sides once + final = 4", () => {
    expect(matchCountOf(TABLE, 6, 1, "semis")).toBe(18);
    expect(matchCountOf(TABLE, 6, 2, "semis")).toBe(33);
    expect(matchCountOf(TABLE, 3, 1, "final")).toBe(4);
  });

  it("a key outside the table is undefined, never a number (one side, seven sides, three plays, a knockout too small)", () => {
    expect(matchCountOf(TABLE, 1, 1, "league")).toBeUndefined();
    expect(matchCountOf(TABLE, 7, 1, "league")).toBeUndefined();
    expect(matchCountOf(TABLE, 3, 3, "league")).toBeUndefined();
    expect(matchCountOf(TABLE, 2, 1, "final"), "no final at two sides").toBeUndefined();
    expect(matchCountOf(TABLE, 3, 1, "semis"), "no semi-finals at three sides").toBeUndefined();
  });
});

describe("setupErrorKey: every refusal the create route can name has copy (T3's table)", () => {
  // T3 report, "Map the codes": five codes have their own line, and branch review A I2 adds the email's; CREATE_FAILED and
  // every other code read the generic one.
  const OWN: Record<string, string> = {
    QUICK_MATCH_TOO_MANY_ALIVE: "quickMatch.errors.tooManyAlive",
    QUICK_MATCH_RATE_LIMITED: "quickMatch.errors.rateLimited",
    QUICK_MATCH_SPORT_NOT_OFFERED: "quickMatch.errors.sportNotOffered",
    QUICK_MATCH_KIND_NOT_OFFERED: "quickMatch.errors.kindNotOffered",
    QUICK_MATCH_FORMAT_NOT_OFFERED: "quickMatch.errors.formatNotOffered",
    QUICK_MATCH_EMAIL_INVALID: "quickMatch.errors.emailInvalid",
    // Review m2: #1136's shared sentence (reload, content blocker), not a quick-match copy of it.
    QUICK_MATCH_TURNSTILE_FAILED: "turnstile.error",
    // Plan 5 T1 review C1: Semi-finals posted with fewer than four sides (an old tab, a crafted post).
    QUICK_MATCH_SEMIS_TOO_FEW_SIDES: "quickMatch.errors.semisTooFewSides",
  };

  it("maps every QUICK_MATCH_ERRORS code; the count is every code there is", () => {
    const codes = Object.values(QUICK_MATCH_ERRORS);
    expect(codes.length).toBeGreaterThanOrEqual(10);
    for (const code of codes) {
      expect(setupErrorKey(code), code).toBe(OWN[code] ?? "quickMatch.errors.generic");
    }
    expect(Object.keys(OWN).every((c) => (codes as readonly string[]).includes(c)), "every own-copy code is a real code").toBe(true);
  });

  it("an unknown or crafted ?e= reads the generic line, never a raw code", () => {
    for (const code of ["NOPE", "", "quickMatch.errors.rateLimited", "__proto__", "constructor"]) {
      expect(setupErrorKey(code), JSON.stringify(code)).toBe("quickMatch.errors.generic");
    }
  });

  it("every key the map can answer is copy the page hands the island (no raw key on screen)", () => {
    for (const key of [...Object.values(OWN), "quickMatch.errors.generic"]) {
      expect((COPY as Record<string, string>)[key], key).toEqual(expect.any(String));
    }
  });

  it("C1: the semi-finals refusal reads its line with the minimum filled in, in every locale, never a bare {min} (counted)", () => {
    // The spec's number (§3: semi-finals need four sides), typed: never QUICK_MATCH_SEMIS_MIN_SIDES, which is what it pins.
    const MIN = "4";
    const dicts = { en: [enMarketing, enUi], es: [esMarketing, esUi], fr: [frMarketing, frUi], nl: [nlMarketing, nlUi] } as const;
    let checked = 0;
    for (const lang of LOCALES) {
      const [marketing, ui] = dicts[lang];
      const line = textOf(
        byTestId(mount({ lang, copy: setupCopy(marketing, ui), initialError: QUICK_MATCH_ERRORS.SEMIS_TOO_FEW_SIDES }), "qm-setup-error")!,
      );
      const raw = (marketing as Record<string, string>)["quickMatch.errors.semisTooFewSides"]!;
      expect(raw, `${lang}: the copy names the minimum`).toContain("{min}");
      expect(line, lang).toBe(raw.replace("{min}", MIN));
      expect(line, `${lang}: no placeholder left`).not.toMatch(/[{}]/);
      checked++;
    }
    expect(checked).toBe(4);
    expect(textOf(byTestId(mount({ initialError: QUICK_MATCH_ERRORS.SEMIS_TOO_FEW_SIDES }), "qm-setup-error")!)).toBe(
      "Semi-finals need 4 or more sides.",
    );
  });
});

describe("submitOutcome: what the followed 303 says", () => {
  it("a home lands on its path; a refusal names its ?e= code; a bare 429 is the rate limit; anything else is a failure", () => {
    expect(submitOutcome({ url: "http://localhost:3000/q/qm_abc", status: 200 })).toEqual({ kind: "home", path: "/q/qm_abc" });
    expect(submitOutcome({ url: "http://localhost:3000/en/play?e=QUICK_MATCH_TOO_MANY_ALIVE", status: 200 })).toEqual({
      kind: "refused",
      code: "QUICK_MATCH_TOO_MANY_ALIVE",
    });
    expect(submitOutcome({ url: "http://localhost:3000/fr/play?e=QUICK_MATCH_KIND_NOT_OFFERED", status: 200 })).toEqual({
      kind: "refused",
      code: "QUICK_MATCH_KIND_NOT_OFFERED",
    });
    expect(submitOutcome({ url: "http://localhost:3000/api/quick-match", status: 429 })).toEqual({
      kind: "refused",
      code: QUICK_MATCH_ERRORS.RATE_LIMITED,
    });
    expect(submitOutcome({ url: "http://localhost:3000/en/play", status: 200 })).toEqual({
      kind: "refused",
      code: QUICK_MATCH_ERRORS.CREATE_FAILED,
    });
    expect(submitOutcome({ url: "", status: 500 })).toEqual({ kind: "refused", code: QUICK_MATCH_ERRORS.CREATE_FAILED });
  });

  it("only the PATH of a home is kept, so the page never navigates off this origin", () => {
    expect(submitOutcome({ url: "https://evil.example/q/qm_x", status: 200 })).toEqual({ kind: "home", path: "/q/qm_x" });
  });

  it("a home landed with the EMAIL_LIMITED line keeps that one ?e=, so the fetch path shows it too (B-m3); nothing else rides along", () => {
    const limited = `?e=${QUICK_MATCH_ERRORS.EMAIL_LIMITED}`;
    expect(submitOutcome({ url: `http://localhost:3000/q/qm_abc${limited}`, status: 200 })).toEqual({
      kind: "home",
      path: `/q/qm_abc${limited}`,
    });
    // Another origin still only gives its path, and its own line.
    expect(submitOutcome({ url: `https://evil.example/q/qm_x${limited}&next=//evil.example`, status: 200 })).toEqual({
      kind: "home",
      path: `/q/qm_x${limited}`,
    });
    // Any other ?e= on a home is not the create's to print: the path alone (the positive pair of the line above).
    for (const e of [QUICK_MATCH_ERRORS.ACTION_FAILED, "javascript:alert(1)", ""]) {
      expect(submitOutcome({ url: `http://localhost:3000/q/qm_abc?e=${encodeURIComponent(e)}`, status: 200 }), e).toEqual({
        kind: "home",
        path: "/q/qm_abc",
      });
    }
  });
});

describe("setupBody: the form's fields, exactly (C3 under the form-post contract)", () => {
  const base = {
    name: "Badminton · Tue, Nov 3",
    sport_key: "badminton",
    variant_key: "bwf",
    kind: "pair" as const,
    sides: ["A", "B", "C"],
    shape: "league" as const,
    plays: 2,
    email: "",
    locale: "en" as const,
  };

  it("nine fields; sides repeated in typed order; a blank email is sent blank (the route maps it to none)", () => {
    const body = setupBody(base);
    expect([...new Set(body.keys())].sort()).toEqual(
      ["email", "kind", "locale", "name", "plays", "shape", "sides", "sport_key", "variant_key"].sort(),
    );
    expect(body.getAll("sides")).toEqual(["A", "B", "C"]);
    expect(body.get("plays")).toBe("2");
    expect(body.get("email")).toBe("");
    expect(body.get("locale")).toBe("en");
  });

  it("the shape goes as picked, the radio's own word, never a format or a count (the route maps it, plan 5 D1); plays too", () => {
    let checked = 0;
    for (const shape of ["league", "final", "semis"] as const) {
      for (const plays of [1, 2]) {
        const body = setupBody({ ...base, shape, plays });
        expect(body.getAll("shape"), `${shape} ${plays}`).toEqual([shape]);
        expect(body.has("format"), "no format field: one radio, one fact").toBe(false);
        expect(body.has("qualifiers")).toBe(false);
        expect(body.get("plays")).toBe(String(plays));
        checked++;
      }
    }
    expect(checked).toBe(6);
  });
});

// ---- the island ---------------------------------------------------------------------------------------------------

/** The Format list's rows, in order: [value, disabled, checked]. */
const shapeRows = (i: Island) =>
  inputs(i, "shape").map((el) => [propsOf(el).value, propsOf(el).disabled === true, propsOf(el).checked === true]);
/** The `<label>` around a shape radio (the row a thumb taps). */
const shapeLabel = (i: Island, value: string) =>
  all(i).find(
    (el) => el.type === "label" && walk(propsOf(el).children as ReactElement).some((c) => c.type === "input" && propsOf(c).name === "shape" && propsOf(c).value === value),
  );
/** What a screen reader says for an element: its text, skipping every aria-hidden subtree (sr-only text is spoken). */
function spoken(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(spoken).join("");
  const el = node as ReactElement;
  const p = propsOf(el);
  if (p["aria-hidden"] === true || p["aria-hidden"] === "true") return "";
  return spoken(p.children);
}
const byId = (i: Island, id: string) => all(i).find((el) => propsOf(el).id === id);
/**
 * A radio's accessible name and description as Chromium computes them: the name is the input's own `aria-label` (it wins over
 * the wrapping label), the description its `aria-describedby` targets. `title` is what browse mode reads of the row's visible
 * title (aria-hidden skipped, the visually hidden comma read), spaces before a comma dropped, as a reader voices them.
 * Driven in a real browser (T6 shots, 2026-11-13): a hidden comma inside a labelledby title came out "League , Final", so the
 * name is an aria-label, which Chromium reports exactly.
 */
function a11yOf(i: Island, value: string): { name: string; description: string; title: string } {
  const input = radio(i, "shape", value);
  if (!input) throw new Error(`no ${value} radio`);
  const ids = (attr: string) => String(propsOf(input)[attr] ?? "").split(/\s+/).filter(Boolean);
  const text = (attr: string) => ids(attr).map((id) => spoken(byId(i, id)).replace(/\s+/g, " ").trim()).join(" ");
  const name = propsOf(input)["aria-label"];
  if (typeof name !== "string") throw new Error(`${value}: no aria-label`);
  if (ids("aria-labelledby").length > 0) throw new Error(`${value}: aria-labelledby would compete with the aria-label`);
  const titleEl = byId(i, `qm-shape-${value}-title`);
  if (!titleEl) throw new Error(`${value}: no title element`);
  const title = spoken(titleEl).replace(/\s+/g, " ").replace(/ ,/g, ",").trim();
  return { name, description: text("aria-describedby"), title };
}

describe("QuickMatchSetupForm: the screen as the mockup orders it", () => {
  it("opens on two side rows; the Format list holds League alone, chosen (spec §12: no knockout at two sides); 2 of 6", () => {
    const i = mount();
    expect(sideInputs(i)).toHaveLength(2);
    expect(shapeRows(i)).toEqual([["league", false, true]]);
    expect(inputs(i, "format"), "no format field: the radio posts `shape`").toEqual([]);
    expect([1, 2, 3].map((n) => radio(i, "plays", String(n)) !== undefined), "Once and Twice only (owner 2026-11-12)").toEqual([true, true, false]);
    expect(i.text()).toContain("2 of 6");
    expect(i.text()).toContain("Each pair plays");
    expect(i.text()).toContain("Format");
  });

  it("the list at every side count follows spec §3: 2 → League; 3 → Semi-finals disabled with its reason; 4..6 → all three (counted)", () => {
    const i = mount();
    const OWNER: Record<number, [string, boolean][]> = {
      2: [["league", false]],
      3: [["league", false], ["final", false], ["semis", true]],
      4: [["league", false], ["final", false], ["semis", false]],
      5: [["league", false], ["final", false], ["semis", false]],
      6: [["league", false], ["final", false], ["semis", false]],
    };
    let checked = 0;
    for (let n = 2; n <= QUICK_MATCH_MAX_SIDES; n++) {
      if (sideInputs(i).length < n) click(buttonNamed(i, "+ Add a side"));
      expect(sideInputs(i), "the row was added").toHaveLength(n);
      expect(shapeRows(i).map(([v, d]) => [v, d]), `${n} sides`).toEqual(OWNER[n]);
      const why = textOf(shapeLabel(i, "semis") ?? <span />);
      if (n === 3) expect(why, "the disabled row keeps its reason visible").toContain("Needs 4 or more sides");
      else expect(why, `${n} sides: no reason on an enabled row`).not.toContain("Needs");
      expect(i.text(), `${n} sides: no plain Knockout (owner 2026-11-12)`).not.toMatch(/\bKnockout\b/);
      checked++;
    }
    expect(checked, "anti-vacuity: 2..6 sides").toBe(5);
    click(buttonNamed(i, "Remove side 6"));
    click(buttonNamed(i, "Remove side 5"));
    click(buttonNamed(i, "Remove side 4"));
    expect(i.text()).toContain("3 of 6");
    fillSides(i, ["A", "B", "C", "D", "E", "F"]);
    expect(sideInputs(i)).toHaveLength(6);
    expect(buttonNamed(i, "+ Add a side"), "no add past six").toBeUndefined();
    expect(i.text()).toContain("6 of 6");
  });

  it("each row is a title and its one-line hint, the count of who goes through filled in (2 and 4)", () => {
    const i = mount();
    fillSides(i, ["A", "B", "C", "D"]);
    expect(textOf(shapeLabel(i, "league")!)).toContain("League");
    // T6 review m1 (controller, 2026-11-13): the plain League row still says who wins.
    expect(textOf(shapeLabel(i, "league")!)).toContain("Everyone plays everyone. Top of the table wins.");
    expect(textOf(shapeLabel(i, "final")!)).toContain("Everyone plays everyone, then the top 2 play a final.");
    expect(textOf(shapeLabel(i, "semis")!)).toContain("Everyone plays everyone, then the top 4 play semi-finals and a final.");
    for (const v of ["league", "final", "semis"]) expect(textOf(shapeLabel(i, v)!), v).not.toMatch(/[{}]/);
  });

  it("C5: each choice's accessible name is in words, never the arrow, in every locale; its hint is its description (counted)", () => {
    const dicts = { en: [enMarketing, enUi], es: [esMarketing, esUi], fr: [frMarketing, frUi], nl: [nlMarketing, nlUi] } as const;
    let checked = 0;
    for (const lang of LOCALES) {
      const [marketing, ui] = dicts[lang];
      const m = marketing as Record<string, string>;
      const i = mount({ lang, copy: setupCopy(marketing, ui) });
      // Four sides, through this locale's own Add button, so every row is enabled.
      while (sideInputs(i).length < 4) click(buttonNamed(i, m["quickMatch.setup.addSide"]!));
      for (const shape of ["league", "final", "semis"] as const) {
        const { name, description, title: read } = a11yOf(i, shape);
        const title = m[`quickMatch.setup.shape.${shape}`]!;
        expect(name, `${lang} ${shape}: no arrow spoken`).not.toContain("→");
        // Every word of the visible title is in the name, in order (label in name, WCAG 2.5.3).
        const words = title.split("→").map((w) => w.trim());
        expect(name, `${lang} ${shape}`).toBe(words.join(", "));
        // Browse mode reads the visible title too: the arrow hidden, a pause (the hidden comma) in its place.
        expect(read, `${lang} ${shape}: the title as browse mode reads it`).toBe(words.join(", "));
        const hint = m[`quickMatch.setup.shape.${shape}Hint`]!.replace("{count}", shape === "final" ? "2" : "4");
        expect(description, `${lang} ${shape}: the hint describes it`).toBe(hint);
        checked++;
      }
      // The two knockout titles really do carry the arrow, so the assertion above is not vacuous.
      expect(m["quickMatch.setup.shape.semis"], lang).toContain("→");
    }
    expect(checked, "4 locales × 3 choices").toBe(12);
    // English, typed: what VoiceOver says.
    const en = mount();
    fillSides(en, ["A", "B", "C"]);
    expect(a11yOf(en, "semis")).toEqual({
      name: "League, Semi-finals, Final",
      description: "Everyone plays everyone, then the top 4 play semi-finals and a final. Needs 4 or more sides",
      title: "League, Semi-finals, Final",
    });
  });

  it("the list is one radio group named Format, a real fieldset, so the browser posts one `shape`", () => {
    const i = mount();
    fillSides(i, ["A", "B", "C"]);
    const group = all(i).filter((el) => propsOf(el).role === "radiogroup");
    expect(group, "one radio group").toHaveLength(1);
    expect(group[0]!.type).toBe("fieldset");
    const legend = walk(propsOf(group[0]!).children as ReactElement).find((el) => el.type === "legend");
    expect(textOf(legend!)).toBe("Format");
    expect(walk(propsOf(group[0]!).children as ReactElement).filter((el) => el.type === "input" && propsOf(el).name === "shape")).toHaveLength(3);
  });

  it("rows 3 to 6 carry a × that removes exactly that row (D5); rows 1 and 2 carry none", () => {
    const i = mount();
    fillSides(i, ["A", "B", "C", "D"]);
    expect(buttonNamed(i, "Remove side 1")).toBeUndefined();
    expect(buttonNamed(i, "Remove side 2")).toBeUndefined();
    expect(buttonNamed(i, "Remove side 3")).toBeDefined();
    expect(buttonNamed(i, "Remove side 4")).toBeDefined();
    click(buttonNamed(i, "Remove side 3"));
    expect(sideInputs(i).map((el) => propsOf(el).value)).toEqual(["A", "B", "D"]);
    expect(sideInputs(i).map((el) => propsOf(el)["aria-label"])).toEqual(["Side 1", "Side 2", "Side 3"]);
    expect(propsOf(sideInputs(i)[0]!).maxLength).toBe(60);
    expect(propsOf(nameInput(i)).maxLength).toBe(80);
    // The browser's bounds are the schema's own (spec E1: 80 and 60).
    expect([QUICK_MATCH_NAME_MAX, QUICK_MATCH_SIDE_NAME_MAX]).toEqual([80, 60]);
  });

  it("the Start count follows the table: singular at one match, plays multiply, two sides is one match", () => {
    const i = mount();
    fillSides(i, ["A", "B"]);
    expect(startText(i)).toBe("Start playing · 1 match");
    type(radio(i, "plays", "2"), "2");
    expect(startText(i)).toBe("Start playing · 2 matches");
    fillSides(i, ["A", "B", "C", "D"]);
    expect(startText(i)).toBe("Start playing · 12 matches"); // 2 × 4·3/2
  });

  it("the Start count is league + knockout (the mockup's 18, 33 and 4), and moves with the choice both ways", () => {
    const i = mount();
    fillSides(i, ["Ines", "Mika", "Ravi", "Sofia", "Tom", "Lena"]);
    expect(startText(i), "League is chosen at first").toBe("Start playing · 15 matches");
    type(radio(i, "shape", "semis"), "semis");
    expect(shapeRows(i).filter(([, , checked]) => checked).map(([v]) => v)).toEqual(["semis"]);
    expect(startText(i)).toBe("Start playing · 18 matches");
    type(radio(i, "plays", "2"), "2");
    expect(startText(i), "Twice doubles the league part only").toBe("Start playing · 33 matches");
    type(radio(i, "shape", "league"), "league");
    expect(startText(i), "back to League").toBe("Start playing · 30 matches");

    const three = mount();
    fillSides(three, ["Ines", "Mika", "Ravi"]);
    type(radio(three, "shape", "final"), "final");
    expect(startText(three)).toBe("Start playing · 4 matches");
  });

  it("removing a side under a choice the list no longer offers falls back, and the count follows (semis → final → league)", () => {
    const i = mount();
    fillSides(i, ["A", "B", "C", "D"]);
    type(radio(i, "shape", "semis"), "semis");
    expect(startText(i)).toBe("Start playing · 9 matches"); // 6 + 3
    click(buttonNamed(i, "Remove side 4"));
    expect(shapeRows(i), "Semi-finals disabled; Final takes the check").toEqual([
      ["league", false, false],
      ["final", false, true],
      ["semis", true, false],
    ]);
    expect(startText(i)).toBe("Start playing · 4 matches"); // 3 + 1
    click(buttonNamed(i, "Remove side 3"));
    expect(shapeRows(i), "two sides: League alone, chosen").toEqual([["league", false, true]]);
    expect(startText(i)).toBe("Start playing · 1 match");
    // Putting the sides back brings the guest's own choice back: it was never theirs to lose.
    click(buttonNamed(i, "+ Add a side"));
    click(buttonNamed(i, "+ Add a side"));
    expect(shapeRows(i).filter(([, , checked]) => checked).map(([v]) => v)).toEqual(["semis"]);
  });

  it("C23: rules that may only play League offer only League, and a knockout chosen on other rules falls back to it", () => {
    const leagueOnly: QuickMatchSport[] = OFFER.map((s) =>
      s.sport_key === "tennis"
        ? { ...s, variants: s.variants.map((v) => (v.variant_key === "fast4" ? { ...v, knockoutAllowed: false } : v)) }
        : s,
    );
    const i = mount({ sports: setupSports(leagueOnly, enUi) as SetupFormProps["sports"] });
    type(radio(i, "sport_key", "tennis"), "tennis");
    fillSides(i, ["A", "B", "C", "D"]);
    const select = () => all(i).find((el) => el.type === "select" && propsOf(el).name === "variant_key")!;
    expect(propsOf(select()).value, "tennis opens on tour, which allows a knockout").toBe("tour");
    type(radio(i, "shape", "semis"), "semis");
    expect(startText(i)).toBe("Start playing · 9 matches");
    type(select(), "fast4");
    expect(shapeRows(i), "fast4: League only").toEqual([["league", false, true]]);
    expect(startText(i)).toBe("Start playing · 6 matches");
    expect(i.text()).not.toContain("Semi-finals");
    type(select(), "tour");
    expect(shapeRows(i).map(([v]) => v), "tour again: all three").toEqual(["league", "final", "semis"]);
  });

  it("'Each pair plays' offers Once and Twice, nothing more (owner 2026-11-12), at two sides and at six", () => {
    // The owner's ruling, typed here on purpose: never read from QUICK_MATCH_MAX_PLAYS, which is what it pins.
    const OWNER = [
      ["1", "Once"],
      ["2", "Twice"],
    ];
    let checked = 0;
    for (const names of [["A", "B"], ["A", "B", "C", "D", "E", "F"]]) {
      const i = mount();
      fillSides(i, names);
      const offered = all(i)
        .filter((el) => el.type === "label" && walk(el).some((c) => c.type === "input" && propsOf(c).name === "plays"))
        .map((el) => {
          const input = walk(el).find((c) => c.type === "input" && propsOf(c).name === "plays")!;
          return [String(propsOf(input).value), textOf(el).trim()];
        });
      expect(offered, `${names.length} sides`).toEqual(OWNER);
      checked += offered.length;
    }
    expect(checked, "anti-vacuity").toBe(4);
  });

  it("once the script runs, Start is disabled while any row is blank or the name is cleared, enabled once every row is filled", () => {
    const i = mount({}, { hydrate: true });
    expect(propsOf(start(i)).disabled).toBe(true);
    fillSides(i, ["A", "B"]);
    expect(propsOf(start(i)).disabled).toBe(false);
    click(buttonNamed(i, "+ Add a side"));
    expect(propsOf(start(i)).disabled, "a blank third row").toBe(true);
    type(sideInputs(i)[2], "   ");
    expect(propsOf(start(i)).disabled, "spaces are blank").toBe(true);
    type(sideInputs(i)[2], "C");
    expect(propsOf(start(i)).disabled).toBe(false);
    type(nameInput(i), " ");
    expect(propsOf(start(i)).disabled, "a blank name").toBe(true);
  });

  it("an out-of-table count is handled: Start reads plain, never '· undefined' (the table guard, reached)", () => {
    const partial = { ...TABLE, "league:2:1": undefined } as QuickMatchPreviewTable;
    const i = mount({ table: partial });
    fillSides(i, ["A", "B"]);
    expect(startText(i)).toBe("Start playing");
    expect(propsOf(start(i)).disabled).toBe(false);
  });
});

describe("sport, kind and match rules (B4b-d, D6, C24)", () => {
  it("chips keep catalog order; the first sport is chosen with its first kind and its preferred variant", () => {
    const i = mount();
    const chips = inputs(i, "sport_key").map((el) => propsOf(el).value);
    expect(chips).toEqual(["badminton", "boardgame", "football", "tennis"]);
    expect(propsOf(radio(i, "sport_key", "badminton")!).checked).toBe(true);
    expect(propsOf(radio(i, "kind", "individual")!).checked).toBe(true);
    const select = all(i).find((el) => el.type === "select" && propsOf(el).name === "variant_key")!;
    // PREFERRED_VARIANT names badminton's bwf-3x15 (lib/preferred-variant.ts); it is offered, so it is the default.
    expect(propsOf(select).value).toBe("bwf-3x15");
  });

  it("changing the sport resets the kind and the rules to that sport's defaults", () => {
    const i = mount();
    type(radio(i, "kind", "pair"), "pair");
    const select = () => all(i).find((el) => el.type === "select" && propsOf(el).name === "variant_key")!;
    type(select(), "short");
    type(radio(i, "sport_key", "tennis"), "tennis");
    expect(propsOf(radio(i, "kind", "individual")!).checked).toBe(true);
    // Tennis's preferred variant is tour, though fast4 is listed first.
    expect(propsOf(select()).value).toBe("tour");
    type(radio(i, "sport_key", "badminton"), "badminton");
    expect(propsOf(select()).value, "the default, not the short rules picked earlier").toBe("bwf-3x15");
    expect(propsOf(radio(i, "kind", "individual")!).checked).toBe(true);
  });

  it("a one-kind sport shows no kind switch and posts its kind (chess: individual)", () => {
    const i = mount();
    type(radio(i, "sport_key", "boardgame"), "boardgame");
    expect(inputs(i, "kind").filter((el) => propsOf(el).type === "radio")).toEqual([]);
    expect(propsOf(hidden(i, "kind")!).value).toBe("individual");
    // Positive pair: a two-kind sport does show the switch.
    type(radio(i, "sport_key", "tennis"), "tennis");
    expect(inputs(i, "kind").filter((el) => propsOf(el).type === "radio")).toHaveLength(2);
  });

  it("?sport= (the hero's sport): the OPENING sport's rules decide the knockout rows, never the offer's first; swept over every non-default sport, both ways (counted)", () => {
    // Spec §3 (2026-11-12-quick-match-league-knockout): a knockout row only on rules that may play one (C23), from three
    // sides, Semi-finals from four. Typed from the spec, never read from shapesOffered. Every live variant may play a
    // knockout today (quick-match-offer.generated.json), so the default is made league-only here: with both free, a form
    // that read the default sport's rules would list the same rows and this could not see it.
    const KNOCKOUT: Record<number, [string, boolean][]> = {
      3: [["league", false], ["final", false], ["semis", true]],
      4: [["league", false], ["final", false], ["semis", false]],
    };
    const LEAGUE_ONLY: [string, boolean][] = [["league", false]];
    const leagueOnly = (s: QuickMatchSport): QuickMatchSport => ({
      ...s,
      variants: s.variants.map((v) => ({ ...v, knockoutAllowed: false })),
    });
    // The page's own chain: `?sport=` through prefillSport (what page.tsx hands the island), then n sides typed.
    const open = (offer: QuickMatchSport[], raw: string | undefined, n: number) => {
      const sports = setupSports(offer, enUi) as SetupFormProps["sports"];
      const i = mount({ sports, initialSport: prefillSport(raw, sports) });
      fillSides(i, Array.from({ length: n }, (_, k) => `S${k + 1}`));
      return i;
    };
    const rowsOf = (i: Island) => shapeRows(i).map(([v, d]) => [v, d]);
    const first = OFFER[0]!.sport_key;
    const opening = OFFER.slice(1).map((s) => s.sport_key);
    expect(opening.length, "premise: at least two sports the form does not open on by default").toBeGreaterThanOrEqual(2);
    let checked = 0;
    for (const key of opening) {
      // The default league-only, the opening sport free to play a knockout: its rows show.
      const freeHere = OFFER.map((s) => (s.sport_key === key ? s : leagueOnly(s)));
      for (const n of [3, 4]) {
        const i = open(freeHere, key, n);
        expect(propsOf(radio(i, "sport_key", key)!).checked, `premise: ?sport=${key} opens on it`).toBe(true);
        expect(rowsOf(i), `?sport=${key}, ${n} sides, the default league-only`).toEqual(KNOCKOUT[n]);
        expect(rowsOf(open(freeHere, undefined, n)), `the differential: no ?sport=, ${n} sides, opens on ${first}`).toEqual(LEAGUE_ONLY);
        checked++;
      }
      // The sequence: from the opening sport to the default chip and back, the rows follow the sport on screen.
      const moved = open(freeHere, key, 4);
      type(radio(moved, "sport_key", first), first);
      expect(rowsOf(moved), `${key} → ${first}: league-only`).toEqual(LEAGUE_ONLY);
      type(radio(moved, "sport_key", key), key);
      expect(rowsOf(moved), `${first} → ${key} again`).toEqual(KNOCKOUT[4]);
      // Reverse: the default free, the opening sport league-only: League alone, where the default lists all three.
      const onlyHere = OFFER.map((s) => (s.sport_key === key ? leagueOnly(s) : s));
      expect(rowsOf(open(onlyHere, key, 4)), `?sport=${key}, itself league-only`).toEqual(LEAGUE_ONLY);
      expect(rowsOf(open(onlyHere, undefined, 4)), `no ?sport=: ${first} lists all three`).toEqual(KNOCKOUT[4]);
      checked++;
    }
    expect(checked, "anti-vacuity: every opening sport at 3 and 4 sides, plus its reverse").toBe(opening.length * 3);
  });

  it("the kind words are the dictionary's (Singles / Doubles), never the engine's", () => {
    const i = mount();
    const kindLabels = all(i)
      .filter((el) => el.type === "label" && walk(propsOf(el).children as ReactElement).some((c) => propsOf(c).name === "kind"))
      .map((el) => textOf(el).trim());
    expect(kindLabels).toEqual(["Singles", "Doubles"]);
  });
});

describe("the suggested name (B4h)", () => {
  it("before hydration the server cannot know the guest's date: the sport name alone", () => {
    const i = mount();
    expect(propsOf(nameInput(i)).value).toBe("Badminton");
  });

  it("after hydration: the sport and the guest's own date; it follows the sport until edited, then stays", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 3, 12, 0, 0)); // Tuesday 3 November 2026, local
    const i = mount({}, { hydrate: true });
    expect(propsOf(nameInput(i)).value).toBe("Badminton · Tue, Nov 3");
    type(radio(i, "sport_key", "tennis"), "tennis");
    expect(propsOf(nameInput(i)).value, "follows the sport").toBe("Tennis · Tue, Nov 3");
    type(nameInput(i), "Friday night");
    type(radio(i, "sport_key", "badminton"), "badminton");
    expect(propsOf(nameInput(i)).value, "edited: stays").toBe("Friday night");
  });

  it("the date is in the page's language (fr)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 3, 12, 0, 0));
    const i = mount({ lang: "fr" }, { hydrate: true });
    expect(propsOf(nameInput(i)).value).toBe(`Badminton · ${new Intl.DateTimeFormat("fr", { weekday: "short", day: "numeric", month: "short" }).format(new Date(2026, 10, 3))}`);
    expect(propsOf(nameInput(i)).value).toMatch(/nov/);
  });
});

describe("submitting (the form-post contract, enhanced: ledger CARRY to T4)", () => {
  type Res = { url: string; status: number };
  function stubFetch(answers: (Res | Error)[]) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch = vi.fn((url: string, init: RequestInit) => {
      calls.push({ url, init });
      const next = answers.shift() ?? answers.at(-1);
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next as Res);
    });
    const assign = vi.fn();
    vi.stubGlobal("fetch", fetch);
    stubWindow(assign);
    return { fetch, calls, assign };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("posts the nine fields to the create route and lands on the home it answers", async () => {
    const { calls, assign } = stubFetch([{ url: "http://localhost:3000/q/qm_tok", status: 200 }]);
    const i = mount();
    type(radio(i, "kind", "pair"), "pair");
    fillSides(i, ["Ravi & Sam", "Priya & Tom", "Lee & Ana"]);
    await submit(i);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/quick-match");
    expect(calls[0]!.init.method).toBe("POST");
    const body = calls[0]!.init.body as URLSearchParams;
    expect(body).toBeInstanceOf(URLSearchParams);
    expect(Object.fromEntries([...new Set(body.keys())].map((k) => [k, body.getAll(k)]))).toEqual({
      name: ["Badminton"],
      sport_key: ["badminton"],
      variant_key: ["bwf-3x15"],
      kind: ["pair"],
      shape: ["league"],
      sides: ["Ravi & Sam", "Priya & Tom", "Lee & Ana"],
      plays: ["1"],
      email: [""],
      locale: ["en"],
    });
    expect(assign).toHaveBeenCalledWith("/q/qm_tok");
  });

  it("a double tap makes one create: the form locks on the first submit (B4f)", async () => {
    let release!: (r: Res) => void;
    const fetch = vi.fn(() => new Promise<Res>((r) => (release = r)));
    vi.stubGlobal("fetch", fetch);
    const i = mount({}, { hydrate: true });
    fillSides(i, ["A", "B"]);
    // Both taps reach the SAME handler, as two events dispatched before React re-renders do: only the lock stops the
    // second (the disabled button and the stale `canStart` both still read "ready" in that closure).
    const onSubmit = propsOf(all(i).find((el) => el.type === "form")!).onSubmit as (e: { preventDefault(): void }) => Promise<void>;
    const first = onSubmit({ preventDefault: () => {} });
    const second = onSubmit({ preventDefault: () => {} });
    // The post waits on the bot check's token (`withTurnstile`) before it is sent; the lock is taken before that wait.
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(propsOf(start(i)).disabled, "Start is disabled while the create runs").toBe(true);
    release({ url: "http://localhost:3000/q/qm_one", status: 200 });
    await Promise.all([first, second]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("a submit with a blank row posts nothing (Enter in a field cannot bypass the disabled Start)", async () => {
    const { fetch } = stubFetch([{ url: "http://localhost:3000/q/qm_no", status: 200 }]);
    const i = mount();
    type(sideInputs(i)[0], "A");
    await submit(i);
    expect(fetch).not.toHaveBeenCalled();
    type(sideInputs(i)[1], "B");
    await submit(i);
    expect(fetch, "positive pair: filled, it posts").toHaveBeenCalledTimes(1);
  });

  it("a refusal shows its copy, keeps the typed sides, and unlocks: a second try posts again", async () => {
    const { fetch } = stubFetch([
      { url: "http://localhost:3000/en/play?e=QUICK_MATCH_TOO_MANY_ALIVE", status: 200 },
      { url: "http://localhost:3000/q/qm_two", status: 200 },
    ]);
    const i = mount();
    fillSides(i, ["Ravi & Sam", "Priya & Tom"]);
    await submit(i);
    await flush();
    // The cap is spec §7.9's 5 alive quick matches per visitor.
    expect(textOf(byTestId(i, "qm-setup-error")!)).toContain("You have 5 quick matches on the go on this device.");
    expect(sideInputs(i).map((el) => propsOf(el).value)).toEqual(["Ravi & Sam", "Priya & Tom"]);
    expect(propsOf(start(i)).disabled).toBe(false);
    await submit(i);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(byTestId(i, "qm-setup-error"), "a new try clears the old error").toBeUndefined();
  });

  it("the rate limit, a bare 429, a create failure and a network failure each read their line", async () => {
    const cases: [Res | Error, string][] = [
      [{ url: "http://localhost:3000/en/play?e=QUICK_MATCH_RATE_LIMITED", status: 200 }, "Too many new matches from this network."],
      [{ url: "http://localhost:3000/api/quick-match", status: 429 }, "Too many new matches from this network."],
      [{ url: "http://localhost:3000/en/play?e=QUICK_MATCH_CREATE_FAILED", status: 200 }, "We couldn't start your quick match."],
      [new TypeError("Failed to fetch"), "We couldn't start your quick match."],
    ];
    for (const [answer, line] of cases) {
      const { assign } = stubFetch([answer]);
      const i = mount();
      fillSides(i, ["A", "B"]);
      await submit(i);
      await flush();
      expect(textOf(byTestId(i, "qm-setup-error")!), JSON.stringify(answer instanceof Error ? answer.message : answer)).toContain(line);
      expect(assign).not.toHaveBeenCalled();
    }
    expect(cases).toHaveLength(4);
  });

  it("an address the schema refuses comes back as its own line, opens the email field, and keeps every name typed (A-I2)", async () => {
    const { fetch } = stubFetch([
      { url: `http://localhost:3000/en/play?e=${QUICK_MATCH_ERRORS.EMAIL_INVALID}`, status: 200 },
      { url: "http://localhost:3000/q/qm_ok", status: 200 },
    ]);
    const i = mount({}, { hydrate: true });
    expect(propsOf(emailDetails(i)).open, "premise: the email field starts folded").toBe(false);
    type(nameInput(i), "Sunday doubles");
    fillSides(i, ["Ravi & Sam", "Priya & Tom"]);
    type(emailInput(i), "ravi@gmail");
    await submit(i);
    await flush();
    expect(textOf(byTestId(i, "qm-setup-error")!)).toContain("Check the email address, or leave it blank.");
    expect(propsOf(emailDetails(i)).open, "the field at fault is open").toBe(true);
    expect(propsOf(nameInput(i)).value).toBe("Sunday doubles");
    expect(sideInputs(i).map((el) => propsOf(el).value)).toEqual(["Ravi & Sam", "Priya & Tom"]);
    expect(propsOf(emailInput(i)).value, "the address too, to correct").toBe("ravi@gmail");
    type(emailInput(i), "ravi@gmail.com");
    await submit(i);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("the no-JS path: ?e=EMAIL_INVALID renders the email field open with its line; any other refusal leaves it folded", () => {
    const limited = mount({ initialError: QUICK_MATCH_ERRORS.EMAIL_INVALID });
    expect(textOf(byTestId(limited, "qm-setup-error")!)).toContain("Check the email address, or leave it blank.");
    expect(propsOf(emailDetails(limited)).open).toBe(true);
    expect(propsOf(emailDetails(mount({ initialError: QUICK_MATCH_ERRORS.TOO_MANY_ALIVE }))).open).toBe(false);
    expect(propsOf(emailDetails(mount())).open).toBe(false);
  });

  describe("the bot check (Cloudflare Turnstile, owner 2026-11-12)", () => {
    /** #1136's sentence for a refused bot check (review m2), typed: the copy is the contract, not the lookup. */
    const BOT_LINE =
      "We couldn't confirm you're a person. Reload the page and try again. If it keeps failing, turn off any content blocker for this site.";

    it("asks for the `quickmatch` widget and mounts exactly one, in the form, wired to the controller that sends", () => {
      const i = mount({}, { hydrate: true });
      expect(turnstileFake.actions.length, "anti-vacuity: the island asked for a widget").toBeGreaterThan(0);
      expect(new Set(turnstileFake.actions)).toEqual(new Set(["quickmatch"]));
      const tree = all(i);
      const widgets = tree.filter((el) => el.type === TurnstileWidget);
      expect(widgets).toHaveLength(1);
      expect(propsOf(widgets[0]!).controller).toBe(turnstileFake.controller);
      expect(tree[0]!.type, "inside the form").toBe("form");
      // The server's HTML (no script yet) carries the same one widget container: it renders nothing until the script runs.
      expect(all(mount()).filter((el) => el.type === TurnstileWidget)).toHaveLength(1);
    });

    it("below 768px the widget sits in the page's flow straight above the Start bar, never in it; from 768px it orders between the error line and Start (m4)", () => {
      // One widget, one DOM, branched at `md` (AGENTS.md: never a second tree; and two mounts on one controller would fight).
      // The Start zone holds [widget, Start bar]. Below `md` the zone is `display: contents`, so both are the form's own children:
      // the widget is in the page above the bar, the bar's sticky range is still the whole form, and a challenge (up to 140px
      // tall) never rides the bar that sticks to a phone's foot. From `md` the zone is a column and the BAR is `display:
      // contents`, so the error line, the widget and Start are its items, ordered as they sat in the bar before.
      const i = mount({ initialError: "QUICK_MATCH_TURNSTILE_FAILED" }, { hydrate: true });
      const tokens = (el: ReactElement | undefined) => String(propsOf(el!).className ?? "").split(/\s+/);
      const zone = byTestId(i, "qm-start-zone");
      expect(zone, "the Start zone").toBeDefined();
      const kids = [propsOf(zone!).children].flat(2).filter(Boolean) as ReactElement[];
      const named = kids.map((k) => (k.type === TurnstileWidget ? "widget" : String(propsOf(k)["data-testid"])));
      expect(named, "the widget straight before the bar, nothing else in the zone").toEqual(["widget", "qm-start-bar"]);
      const bar = byTestId(i, "qm-start-bar")!;
      expect(walk(bar).filter((el) => el.type === TurnstileWidget), "never inside the bar that sticks").toHaveLength(0);
      // Token compares, never a `\b` regex: `md:contents` must not match inside `max-md:contents` (AGENTS.md).
      expect(tokens(zone)).toEqual(expect.arrayContaining(["max-md:contents", "md:flex", "md:flex-col"]));
      expect(tokens(zone).filter((c) => c === "contents" || c === "flex"), "no unprefixed display on the zone").toEqual([]);
      expect(tokens(bar)).toContain("md:contents");
      expect(tokens(bar).filter((c) => /^(max-md:|sm:|max-sm:)?contents$/.test(c)), "the bar is a real box below md").toEqual([]);
      // From md, the visual order: the error line (order 0), the widget, then Start.
      const error = byTestId(i, "qm-setup-error");
      expect(error, "the error line is shown, so its order is checked").toBeDefined();
      expect(tokens(error).filter((c) => /^md:-?order-/.test(c)), "error line: default order, first").toEqual([]);
      expect(tokens(kids[0])).toContain("md:order-1");
      expect(tokens(start(i))).toContain("md:order-2");
      // Below md the zone adds no box, so the zone's top margin is md-only and the gap above the widget is the widget's own:
      // `max-md:mt-8` collapses into the bar's smaller one while the widget is an empty box (the page as it was), and sits the
      // widget 32px under the email field, 12px over the bar, once Cloudflare shows a challenge.
      expect(tokens(zone)).toContain("md:mt-8");
      expect(tokens(kids[0])).toContain("max-md:mt-8");
      expect(tokens(bar)).toContain("mt-3");
      expect(tokens(bar)).not.toContain("mt-8");
    });

    it("a held token travels in the cf-turnstile-response header, never in the body, and the widget is reset after", async () => {
      turnstileFake.token = "tok-1";
      const { calls } = stubFetch([{ url: "http://localhost:3000/q/qm_tok", status: 200 }]);
      const i = mount();
      fillSides(i, ["A", "B"]);
      await submit(i);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.init.headers).toEqual({ "cf-turnstile-response": "tok-1" });
      const body = calls[0]!.init.body as URLSearchParams;
      expect([...body.keys()].filter((k) => /turnstile/i.test(k)), "the token is not a form field").toEqual([]);
      expect([...body.values()]).not.toContain("tok-1");
      expect(turnstileFake.resets, "a token is single-use: reset once it was sent").toBe(1);
    });

    it("no token (no site key: dev, e2e): the post goes with NO header and the widget is still reset", async () => {
      const { calls } = stubFetch([{ url: "http://localhost:3000/q/qm_tok", status: 200 }]);
      const i = mount();
      fillSides(i, ["A", "B"]);
      await submit(i);
      expect(calls).toHaveLength(1);
      expect(Object.keys((calls[0]!.init.headers ?? {}) as Record<string, string>)).toEqual([]);
      expect(turnstileFake.resets).toBe(1);
    });

    it("QUICK_MATCH_TURNSTILE_FAILED shows the bot-check line, keeps every name, unlocks; the retry carries the widget's NEW token", async () => {
      turnstileFake.token = "tok-1";
      const { calls, assign } = stubFetch([
        { url: `http://localhost:3000/en/play?e=QUICK_MATCH_TURNSTILE_FAILED`, status: 200 },
        { url: "http://localhost:3000/q/qm_two", status: 200 },
      ]);
      const i = mount({}, { hydrate: true });
      type(nameInput(i), "Sunday doubles");
      fillSides(i, ["Ravi & Sam", "Priya & Tom"]);
      await submit(i);
      await flush();
      expect(textOf(byTestId(i, "qm-setup-error")!)).toContain(BOT_LINE);
      expect(propsOf(nameInput(i)).value).toBe("Sunday doubles");
      expect(sideInputs(i).map((el) => propsOf(el).value)).toEqual(["Ravi & Sam", "Priya & Tom"]);
      expect(propsOf(start(i)).disabled, "unlocked for the retry").toBe(false);
      expect(assign).not.toHaveBeenCalled();
      // The widget fetched a fresh token after the reset; the retry carries it, not the spent one.
      turnstileFake.token = "tok-2";
      await submit(i);
      expect(calls.map((c) => (c.init.headers as Record<string, string>)["cf-turnstile-response"])).toEqual(["tok-1", "tok-2"]);
      expect(turnstileFake.resets).toBe(2);
      expect(assign).toHaveBeenCalledWith("/q/qm_two");
    });

    it("Start tapped while a challenge waits on the guest: no post and no 20s wait; the box is shown and a line says so at once; the next tap posts (ruling 2026-11-12)", async () => {
      /** The controller's ruling, typed: the copy is the contract. It names the button as rendered (final review A m-3). */
      const TICK_LINE = "Tick the check above, then tap Start playing.";
      turnstileFake.awaiting = true;
      const { calls, assign } = stubFetch([{ url: "http://localhost:3000/q/qm_tick", status: 200 }]);
      const i = mount({ initialError: "QUICK_MATCH_RATE_LIMITED" }, { hydrate: true });
      type(nameInput(i), "Sunday doubles");
      fillSides(i, ["Ravi & Sam", "Priya & Tom"]);
      const prompt = () => byTestId(i, "qm-check-prompt");
      const cls = () => String(propsOf(prompt()!).className ?? "").split(/\s+/);
      // Idle: the live region is mounted (so the line is announced when it fills), empty and off screen.
      expect(prompt(), "the status line is always mounted").toBeDefined();
      expect(propsOf(prompt()!).role).toBe("status");
      expect(textOf(prompt()!).trim()).toBe("");
      expect(cls()).toContain("sr-only");
      await submit(i);
      expect(calls, "nothing posted while the box is unticked").toHaveLength(0);
      expect(turnstileFake.reveals, "the box was brought into view").toBe(1);
      expect(turnstileFake.resets, "no token was asked for or spent").toBe(0);
      expect(textOf(prompt()!)).toBe(TICK_LINE);
      expect(cls()).not.toContain("sr-only");
      expect(byTestId(i, "qm-setup-error"), "the old error gives way to the prompt").toBeUndefined();
      expect(propsOf(start(i)).disabled, "never locked: the guest taps Start again").toBe(false);
      expect(propsOf(nameInput(i)).value, "every name kept").toBe("Sunday doubles");
      // A second tap, still unticked: shown again, still nothing posted (sequence).
      await submit(i);
      expect(calls).toHaveLength(0);
      expect(turnstileFake.reveals).toBe(2);
      // The guest ticks the box (the widget now holds a token) and taps Start: the post goes, with that token.
      turnstileFake.awaiting = false;
      turnstileFake.token = "tok-ticked";
      await submit(i);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.init.headers).toEqual({ "cf-turnstile-response": "tok-ticked" });
      expect(textOf(prompt()!).trim(), "the line clears once the post goes").toBe("");
      expect(turnstileFake.reveals, "not shown again on a tap that posts").toBe(2);
      expect(assign).toHaveBeenCalledWith("/q/qm_tick");
    });

    it("in every locale, the tick line names the Start button exactly as the button renders its label (final review A m-3)", async () => {
      // The label is read off the rendered button (its text without the live match count), never typed, so a renamed button
      // reds here until the line follows it. Controller ruling: the line names the button as rendered, in all four locales.
      const DICTS: Record<(typeof LOCALES)[number], [Record<string, string>, Record<string, string>]> = {
        en: [enMarketing, enUi],
        es: [esMarketing, esUi],
        fr: [frMarketing, frUi],
        nl: [nlMarketing, nlUi],
      };
      const checked: string[] = [];
      for (const l of LOCALES) {
        const [marketing, ui] = DICTS[l];
        turnstileFake.awaiting = true;
        stubFetch([{ url: "http://localhost:3000/q/qm_tick", status: 200 }]);
        const i = mount(
          { lang: l, copy: setupCopy(marketing, ui), sports: setupSports(OFFER, ui) as SetupFormProps["sports"] },
          { hydrate: true },
        );
        type(nameInput(i), "Sunday doubles");
        fillSides(i, ["Ravi & Sam", "Priya & Tom"]);
        await submit(i);
        const button = start(i);
        const count = walk(button).find((el) => propsOf(el)["data-testid"] === "qm-start-count");
        expect(count, `${l}: the count is its own node, so it can be set aside`).toBeDefined();
        const label = textOf(button).replace(textOf(count!), "").replace(/\s+/g, " ").trim();
        expect(label, `${l}: the button renders a label`).not.toBe("");
        const line = textOf(byTestId(i, "qm-check-prompt")!).trim();
        expect(line, `${l}: the tick line is showing`).not.toBe("");
        expect(line, `${l}: it names the button as rendered ("${label}")`).toContain(label);
        checked.push(l);
      }
      expect(checked, "anti-vacuity: every locale checked").toEqual([...LOCALES]);
    });

    it("the tick line sits in the Start bar beside Start: from 768px after the widget and before Start (one live region)", () => {
      const i = mount({}, { hydrate: true });
      const bar = byTestId(i, "qm-start-bar")!;
      const prompts = all(i).filter((el) => propsOf(el)["data-testid"] === "qm-check-prompt");
      expect(prompts, "exactly one").toHaveLength(1);
      const inBar = walk(bar);
      expect(inBar.includes(prompts[0]!), "in the Start bar").toBe(true);
      expect(inBar.indexOf(start(i)) > inBar.indexOf(prompts[0]!), "before Start").toBe(true);
      // From md the bar is `display: contents`: the widget is order 1 and comes first in the DOM, so a line also at order 1
      // sits after it ("the check above") and before Start (order 2).
      expect(String(propsOf(prompts[0]!).className).split(/\s+/)).toContain("md:order-1");
    });

    it("without the script, a line beside Start says a quick match needs JavaScript (review m3)", () => {
      const i = mount(); // the server's HTML: no script yet
      const bar = byTestId(i, "qm-start-bar")!;
      const inBar = walk(bar);
      const lines = inBar.filter((el) => el.type === "noscript");
      expect(lines, "one noscript line, in the Start bar").toHaveLength(1);
      expect(textOf(lines[0]!).trim()).toBe("Starting a quick match needs JavaScript.");
      expect(inBar.indexOf(lines[0]!) > inBar.indexOf(start(i)), "after Start").toBe(true);
      // From md the bar is `display: contents`, so the line is a flex item of the zone: last, after Start (order 2).
      expect(String(propsOf(lines[0]!).className).split(/\s+/)).toContain("md:order-3");
    });

    it("the no-JS path: a post without the script carries no token and comes back ?e=QUICK_MATCH_TURNSTILE_FAILED, which renders its line", () => {
      const i = mount({ initialError: "QUICK_MATCH_TURNSTILE_FAILED" });
      expect(textOf(byTestId(i, "qm-setup-error")!)).toContain(BOT_LINE);
      expect(propsOf(emailDetails(i)).open, "not the email's fault: its fold stays shut").toBe(false);
    });
  });

  it("the inputs carry the schema's checks as patterns: a non-blank name and sides (A-M2), and the schema's email (A-I2)", () => {
    const i = mount();
    expect(propsOf(nameInput(i)).pattern).toBe(QUICK_MATCH_NON_BLANK_PATTERN);
    expect(sideInputs(i).map((el) => propsOf(el).pattern)).toEqual([QUICK_MATCH_NON_BLANK_PATTERN, QUICK_MATCH_NON_BLANK_PATTERN]);
    expect(propsOf(emailInput(i)).pattern).toBe(QUICK_MATCH_EMAIL_PATTERN);
    expect(propsOf(emailInput(i)).type).toBe("email");
  });

  it("each patterned input's `title` is the app's own line, which the browser's bubble carries (review m5)", () => {
    // The pattern now stops a bad address or an all-space name BEFORE the post, so the server's EMAIL_INVALID line is no
    // longer what a typing guest meets: the browser's generic bubble is, and it appends the input's title.
    const nameLine = enMarketing["quickMatch.errors.nameBlank"];
    const emailLine = enMarketing["quickMatch.errors.emailInvalid"];
    expect(nameLine, "premise: the dictionary holds the name line").toEqual(expect.any(String));
    expect(emailLine).toEqual(expect.any(String));
    const i = mount();
    expect(propsOf(nameInput(i)).title).toBe(nameLine);
    const sides = sideInputs(i);
    expect(sides.length, "anti-vacuity: the side inputs on first paint").toBeGreaterThan(0);
    expect(sides.map((el) => propsOf(el).title)).toEqual(sides.map(() => nameLine));
    expect(propsOf(emailInput(i)).title).toBe(emailLine);
  });

  it("each pattern, as the browser runs it (anchored, `v` flag), agrees with CreateQuickMatch on a counted table", () => {
    // The browser compiles a pattern as ^(?:p)$ with the `v` flag (HTML §4.10.5.3.6); a pattern that does not compile is
    // ignored, which would silently drop the check.
    const asBrowser = (p: string) => new RegExp(`^(?:${p})$`, "v");
    const email = asBrowser(QUICK_MATCH_EMAIL_PATTERN);
    const schemaTakesEmail = (v: string) => CreateQuickMatch.shape.email.safeParse(v).success;
    const addresses = [
      // refused by the schema: the review's realistic typos first
      "ravi@gmail", "ravi.@gmail.com", "ravi@gmail.c", "ravi..s@gmail.com", ".ravi@gmail.com", "ravi@-gmail.com",
      "ravi@gmail.com.", "ravi@gm_ail.com", "ravi gmail.com", "ravi@@gmail.com", "@gmail.com", "ravi@",
      // taken by the schema
      "ravi@gmail.com", "ravi+x@sub.gmail.co.uk", "o'neil@x.ie", "RAVI@GMAIL.COM", "a@b.cd", "first.last@example.org", "a-b@c-d.io",
    ];
    let refused = 0;
    let taken = 0;
    for (const a of addresses) {
      const schema = schemaTakesEmail(a);
      expect(email.test(a), `${a}: pattern agrees with the schema (${schema})`).toBe(schema);
      if (schema) taken++;
      else refused++;
    }
    expect([refused, taken], "anti-vacuity: both verdicts are exercised").toEqual([12, 7]);

    // The non-blank pattern against the schema's trimmed min(1), on a side name and on the match name.
    const nonBlank = asBrowser(QUICK_MATCH_NON_BLANK_PATTERN);
    const names = ["", " ", "   ", "\t", "A", " A", "A ", " Ravi & Sam "];
    const sideTakes = (v: string) => CreateQuickMatch.shape.sides.element.safeParse(v).success;
    const nameTakes = (v: string) => CreateQuickMatch.shape.name.safeParse(v).success;
    let checked = 0;
    for (const n of names) {
      expect(nonBlank.test(n), JSON.stringify(n)).toBe(sideTakes(n));
      expect(nonBlank.test(n), JSON.stringify(n)).toBe(nameTakes(n));
      checked++;
    }
    expect(checked).toBe(names.length);
    expect(names.filter(sideTakes), "both verdicts").toHaveLength(4);
  });

  it("the server's ?e= (the no-JS path) shows on the first render; an unknown code reads the generic line", () => {
    expect(textOf(byTestId(mount({ initialError: "QUICK_MATCH_KIND_NOT_OFFERED" }), "qm-setup-error")!)).toContain(
      "That choice of singles, doubles or team doesn't fit this sport.",
    );
    expect(textOf(byTestId(mount({ initialError: "SOMETHING_ELSE" }), "qm-setup-error")!)).toContain(
      "We couldn't start your quick match.",
    );
    expect(byTestId(mount({ initialError: null }), "qm-setup-error")).toBeUndefined();
  });

  it("the enhanced post sends the shape on screen and the plays picked; chess posts kind individual", async () => {
    const { calls } = stubFetch([{ url: "http://localhost:3000/q/qm_lg", status: 200 }]);
    const i = mount();
    type(radio(i, "sport_key", "boardgame"), "boardgame");
    fillSides(i, ["A", "B", "C", "D"]);
    type(radio(i, "plays", "2"), "2");
    type(radio(i, "shape", "semis"), "semis");
    await submit(i);
    const body = calls[0]!.init.body as URLSearchParams;
    expect(body.getAll("shape")).toEqual(["semis"]);
    expect(body.has("format")).toBe(false);
    expect(body.get("plays")).toBe("2");
    expect(body.get("kind")).toBe("individual");
    expect(body.get("sport_key")).toBe("boardgame");
  });

  it("the post sends the choice the screen SHOWS: Semi-finals chosen, then a side removed, posts final (counted both ways)", async () => {
    const { calls } = stubFetch([
      { url: "http://localhost:3000/q/qm_a", status: 200 },
      { url: "http://localhost:3000/q/qm_b", status: 200 },
    ]);
    const shown: string[] = [];
    for (const drop of [false, true]) {
      const i = mount();
      fillSides(i, ["A", "B", "C", "D"]);
      type(radio(i, "shape", "semis"), "semis");
      if (drop) click(buttonNamed(i, "Remove side 4"));
      shown.push(String(shapeRows(i).find(([, , checked]) => checked)![0]));
      await submit(i);
    }
    expect(shown).toEqual(["semis", "final"]);
    expect(calls.map((c) => (c.init.body as URLSearchParams).get("shape"))).toEqual(shown);
  });

  it("the form is a real post to the create route with its locale; before the script runs Start is live and `required` guards the names", () => {
    const i = mount();
    const form = all(i).find((el) => el.type === "form")!;
    expect(propsOf(form).method).toBe("post");
    expect(propsOf(form).action).toBe("/api/quick-match");
    expect(propsOf(hidden(mount({ lang: "nl" }), "locale")!).value).toBe("nl");
    // The server's render (no script yet): blank rows, and still Start is not disabled — the browser's own `required`
    // check stops a post with a blank name, and nothing would ever re-enable a disabled Start without the script (I1).
    expect(propsOf(start(i)).disabled).toBe(false);
    expect(sideInputs(i).map((el) => propsOf(el).required)).toEqual([true, true]);
    expect(propsOf(nameInput(i)).required).toBe(true);
    // Positive pair: once the script runs, the same blank rows disable it.
    expect(propsOf(start(mount({}, { hydrate: true }))).disabled).toBe(true);
  });

  it("before the script runs only the chosen sport's chip can be picked (its kinds and rules are the ones on screen), and no side can be added; after, every chip and Add can", () => {
    const before = mount();
    const chips = (i: Island) => inputs(i, "sport_key").map((el) => [propsOf(el).value, propsOf(el).disabled]);
    expect(chips(before)).toEqual([
      ["badminton", false],
      ["boardgame", true],
      ["football", true],
      ["tennis", true],
    ]);
    expect(propsOf(buttonNamed(before, "+ Add a side")!).disabled).toBe(true);
    const after = mount({}, { hydrate: true });
    expect(chips(after).every(([, disabled]) => disabled === false)).toBe(true);
    expect(chips(after)).toHaveLength(4);
    expect(propsOf(buttonNamed(after, "+ Add a side")!).disabled).toBe(false);
  });

  it("back from the home (bfcache): a restored page unlocks; a fresh pageshow does not (m9)", async () => {
    const { fetch } = stubFetch([{ url: "http://localhost:3000/q/qm_a", status: 200 }]);
    const i = mount({}, { hydrate: true });
    fillSides(i, ["A", "B"]);
    await submit(i);
    expect(fetch).toHaveBeenCalledTimes(1);
    await submit(i);
    expect(fetch, "locked: the page is leaving").toHaveBeenCalledTimes(1);
    firePageshow(false);
    await submit(i);
    expect(fetch, "an ordinary load is not a restore").toHaveBeenCalledTimes(1);
    expect(pageListeners.get("pageshow")?.size, "one pageshow listener").toBe(1);
    firePageshow(true);
    expect(propsOf(start(i)).disabled, "Start is live again").toBe(false);
    await submit(i);
    expect(fetch, "unlocked: a second create posts").toHaveBeenCalledTimes(2);
  });
});


describe("what a screen reader hears, what a thumb can hit, where the Start bar sits (review m2-m5, m7)", () => {
  const classOf = (el: ReactElement | undefined) => String(propsOf(el!).className ?? "");

  it("the match count is a polite live region that is always mounted, so a change is heard; the kind switch has a legend", () => {
    const i = mount();
    const live = byTestId(i, "qm-start-count");
    expect(propsOf(live!)["aria-live"]).toBe("polite");
    expect(textOf(live!).trim()).toBe("· 1 match");
    fillSides(i, ["A", "B", "C"]);
    expect(textOf(byTestId(i, "qm-start-count")!).trim()).toBe("· 3 matches");
    // An out-of-table count empties the region; the region itself stays.
    const partial = { ...TABLE, "league:2:1": undefined } as QuickMatchPreviewTable;
    const empty = byTestId(mount({ table: partial }), "qm-start-count");
    expect(empty, "still mounted").toBeDefined();
    expect(textOf(empty!).trim()).toBe("");
    const legend = all(i).find((el) => el.type === "legend" && classOf(el).includes("sr-only"));
    expect(textOf(legend!)).toBe("Who plays");
  });

  it("every tap target has a 44px floor of its own, and no element carries two text sizes or two vertical paddings; 18 checked", () => {
    const i = mount({}, { hydrate: true });
    fillSides(i, ["A", "B", "C"]); // a ×
    const faces = (name: string) =>
      all(i)
        .filter((el) => el.type === "label" && walk(propsOf(el).children as ReactElement).some((c) => propsOf(c).name === name))
        .map((label) => walk(propsOf(label).children as ReactElement).find((c) => c.type === "span")!);
    const targets: [string, ReactElement][] = [
      ...faces("sport_key").map((el): [string, ReactElement] => ["chip", el]),
      ...faces("kind").map((el): [string, ReactElement] => ["kind", el]),
      ...faces("plays").map((el): [string, ReactElement] => ["plays", el]),
      ...sideInputs(i).map((el): [string, ReactElement] => ["side", el]),
      ["remove", buttonNamed(i, "Remove side 3")!],
      ["add", buttonNamed(i, "+ Add a side")!],
      ["rules", all(i).find((el) => el.type === "select")!],
      ["email", all(i).find((el) => el.type === "summary")!],
      // The Format list: the whole row is the label a thumb taps (the radio itself is visually hidden).
      ...(["league", "final", "semis"] as const).map((v): [string, ReactElement] => [`shape ${v}`, shapeLabel(i, v)!]),
    ];
    for (const [what, el] of targets) {
      const cls = classOf(el).split(/\s+/);
      const floor = cls.includes("min-h-11") || (cls.includes("h-11") && cls.includes("w-11"));
      expect(floor, `${what}: ${classOf(el)}`).toBe(true);
      expect(cls.filter((c) => /^text-(xs|sm|base|lg|xl)$/.test(c)).length, `${what}: one text size`).toBeLessThanOrEqual(1);
      expect(cls.filter((c) => /^py-/.test(c)).length, `${what}: one vertical padding`).toBeLessThanOrEqual(1);
    }
    // 4 chips, 2 kinds, 2 plays, 3 sides, ×, Add, rules, email, 3 format rows.
    expect(targets).toHaveLength(18);
  });

  it("the Format rows' checked, focus and disabled looks are CSS, so they hold before the script runs; every class compiles (counted)", async () => {
    const i = mount();
    fillSides(i, ["A", "B", "C"]);
    const row = classOf(shapeLabel(i, "final")).split(/\s+/);
    const off = classOf(shapeLabel(i, "semis")).split(/\s+/);
    // A checked row is drawn by the browser from the radio's own state (no JS needed): the label's `has-checked:` and the
    // dot's `peer-checked:`. React's `checked` only seeds it.
    expect(row.filter((c) => c.startsWith("has-checked:")).length, "checked row look").toBeGreaterThan(0);
    expect(row.filter((c) => c.startsWith("has-focus-visible:")).length, "keyboard focus shows on the row").toBeGreaterThan(0);
    const dot = walk(propsOf(shapeLabel(i, "final")!).children as ReactElement).find((el) => el.type === "span" && propsOf(el)["aria-hidden"] === true)!;
    const dotCls = classOf(dot).split(/\s+/);
    expect(dotCls.filter((c) => c.startsWith("peer-checked:")).length, "the dot fills").toBeGreaterThan(0);
    expect(off, "a disabled row reads as not pickable").toEqual(expect.arrayContaining(["cursor-not-allowed", "border-dashed"]));
    expect(row, "an enabled row is not").not.toContain("cursor-not-allowed");
    const variants = [...row, ...dotCls, ...off].filter((c) => /^(has-checked|has-focus-visible|peer-checked):/.test(c));
    const compiled = await compileClasses(variants);
    let nonEmpty = 0;
    for (const c of variants) {
      expect(Object.keys(compiled.get(c)!).length, `${c}: an unknown utility compiles to nothing`).toBeGreaterThan(0);
      nonEmpty++;
    }
    expect(nonEmpty, "anti-vacuity").toBeGreaterThanOrEqual(5);
    expect(nonEmpty).toBe(variants.length);
  }, 30_000);

  it("the Start bar sticks inside the form below 640px, never as a fixed bar with a spacer, and un-docks while the cookie banner is open", () => {
    const i = mount();
    const bar = classOf(byTestId(i, "qm-start-bar")).split(/\s+/);
    expect(bar).toEqual(expect.arrayContaining(["max-sm:sticky", "max-sm:bottom-0"]));
    // The contract with cookie-consent.tsx: the attribute the banner sets on <html> is the one this variant names.
    expect(CONSENT_OPEN_ATTR).toBe("data-consent-open");
    expect(bar).toContain(`[html[${CONSENT_OPEN_ATTR}]_&]:static`);
    expect(all(i).some((el) => /\bbottom-bar(-spacer)?\b/.test(classOf(el))), "no fixed bar, no spacer").toBe(false);
    // Its one wrapper (the Start zone, m4) adds no box below 768px, so the bar's sticky range is the whole form, not the zone.
    expect(classOf(byTestId(i, "qm-start-zone")).split(/\s+/)).toContain("max-md:contents");
    const form = all(i).find((el) => el.type === "form")!;
    expect(walk(propsOf(form).children as ReactElement).includes(byTestId(i, "qm-start-bar")!), "inside the form").toBe(true);
  });
});
