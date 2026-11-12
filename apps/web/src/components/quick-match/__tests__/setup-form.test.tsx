// The quick match setup island (plan 2 Task 4; spec docs/superpowers/specs/2026-11-03-quick-match-design.md §5 step 2,
// C16, C17, C22, C23; pre-flight amendments B4, C1, C3, D5, D6, D15, Q2; ledger carries "CARRY to T4").
//
// No DOM here (vitest `environment: "node"`): the island is driven through `renderIsland`, whose dispatcher runs its
// hooks, and its handlers are called as a browser would call them. Two real producers feed it, never a fixture:
//  - the server's precomputed table, `quickMatchPreviewTable()` (T2), so every count and draw below is the generator's;
//  - the page's own copy and sport builders (`setupCopy`, `setupSports`) over the real en dictionaries, so a key the
//    page forgets to hand over shows up here as a raw key in an English assertion.
// Expected values come from the rulebook (spec C6/C22, §7.3: a league is plays × n(n−1)/2 matches, a knockout n − 1,
// seed i meets seed N+1−i, byes go to the top seeds) and from T3's code table, never from the island.
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
import {
  quickMatchPreviewTable,
  type QuickMatchKnockoutCell,
  type QuickMatchPreviewTable,
} from "@/server/usecases/quick-match-preview";
import type { QuickMatchSport } from "@/server/usecases/quick-match-sports";
import { propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";
import { setupCopy, setupSports } from "@/app/[lang]/(marketing)/play/setup-props";
import { CONSENT_OPEN_ATTR } from "@/components/cookie-consent";
import { TurnstileWidget } from "@/components/turnstile-widget";
import {
  QuickMatchSetupForm,
  drawPreview,
  formatOffer,
  matchCountOf,
  setupBody,
  setupErrorKey,
  submitOutcome,
  type SetupFormProps,
} from "../setup-form";

const TABLE = quickMatchPreviewTable();
const COPY = setupCopy(enMarketing, enUi);
const msg = (key: string, vars?: Record<string, string | number>) =>
  Object.entries(vars ?? {}).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), (COPY as Record<string, string>)[key] ?? key);

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

/** D15 is unreachable in v1 (every offered variant allows a knockout), so it is mocked: one variant that can end level. */
const LEVEL_OFFER: QuickMatchSport[] = [
  {
    sport_key: "football",
    labelKey: "sport.football",
    kinds: ["team"],
    variants: [
      { variant_key: "11-a-side", labelKey: "variant.football.elevenASide", knockoutAllowed: true },
      { variant_key: "youth", labelKey: "variant.football.youth", knockoutAllowed: false },
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
  it("every league is plays × n(n−1)/2 and every knockout n − 1 (rulebook); 24 cells checked", () => {
    let checked = 0;
    for (let n = 2; n <= QUICK_MATCH_MAX_SIDES; n++) {
      for (let plays = 1; plays <= QUICK_MATCH_MAX_PLAYS; plays++) {
        expect(matchCountOf(TABLE, "league", n, plays), `league ${n}×${plays}`).toBe((plays * n * (n - 1)) / 2);
        checked++;
      }
    }
    for (let n = 3; n <= QUICK_MATCH_MAX_SIDES; n++) {
      // A knockout has no plays: any plays value reads the same cell.
      expect(matchCountOf(TABLE, "knockout", n, 3), `knockout of ${n}`).toBe(n - 1);
      checked++;
    }
    expect(checked).toBe(24);
  });

  it("a key outside the table is undefined, never a number (a knockout of two, seven sides)", () => {
    expect(matchCountOf(TABLE, "knockout", 2, 1)).toBeUndefined();
    expect(matchCountOf(TABLE, "league", 7, 1)).toBeUndefined();
  });
});

describe("formatOffer: the format row (C16) and the knockout gate (C23/D15)", () => {
  it("hidden at two sides whatever the rules; both at 3..6 where a knockout is allowed, League alone where not; 10 checked", () => {
    const seen: string[] = [];
    for (const allowed of [true, false]) {
      expect(formatOffer(2, allowed)).toBe("hidden");
      seen.push(`2:${allowed}`);
      for (let n = 3; n <= QUICK_MATCH_MAX_SIDES; n++) {
        expect(formatOffer(n, allowed), `${n} sides, knockoutAllowed ${allowed}`).toBe(allowed ? "both" : "leagueOnly");
        seen.push(`${n}:${allowed}`);
      }
    }
    expect(seen).toHaveLength(10);
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

describe("drawPreview: the knockout draw as the generator makes it, under the typed names (C22)", () => {
  const NAMES = ["Ravi & Sam", "Priya & Tom", "Lee & Ana", "Jo & Max", "Kim & Raj", "Ola & Ben"];
  const cellOf = (n: number): QuickMatchKnockoutCell => {
    const cell = TABLE[`knockout:${n}:1`];
    if (!cell) throw new Error(`no knockout of ${n} in the table`);
    return cell;
  };
  const pairOf = (line: string) => line.split(" v ").sort();
  const sorted = (...names: string[]) => [...names].sort();

  it("4 sides: two semi-finals 1v4 and 2v3, then the winners meet; nobody sits out", () => {
    const d = drawPreview(cellOf(4), NAMES.slice(0, 4), msg);
    expect(d.sitsOut).toEqual([]);
    expect(d.cards).toHaveLength(3); // n − 1 matches
    expect(d.cards.map((c) => c.label)).toEqual(["Semi-final 1", "Semi-final 2", "Final"]);
    const semis = d.cards.filter((c) => c.label.startsWith("Semi-final"));
    expect(semis.map((c) => pairOf(c.line)).sort()).toEqual([sorted(NAMES[0]!, NAMES[3]!), sorted(NAMES[1]!, NAMES[2]!)].sort());
    expect(d.cards.at(-1)).toEqual({ label: "Final", line: "Winners meet" });
  });

  it("3 sides: the top seed sits out, meets the winner of the one semi-final", () => {
    const d = drawPreview(cellOf(3), NAMES.slice(0, 3), msg);
    expect(d.sitsOut).toEqual([`${NAMES[0]} sits out the first round`]);
    expect(d.cards).toHaveLength(2);
    // The round has one fixture, so neither it nor its winner is numbered (ruling 2026-11-08, fixture-label.ts).
    expect(d.cards[0]!.label).toBe("Semi-final");
    expect(pairOf(d.cards[0]!.line)).toEqual(sorted(NAMES[1]!, NAMES[2]!));
    expect(d.cards[1]!.label).toBe("Final");
    expect(pairOf(d.cards[1]!.line)).toEqual(sorted(NAMES[0]!, "Winner of the semi-final"));
  });

  it("5 sides: seeds 1-3 sit out (in seed order), 4v5 is the lone quarter-final, its winner meets seed 1", () => {
    const d = drawPreview(cellOf(5), NAMES.slice(0, 5), msg);
    expect(d.sitsOut).toEqual([0, 1, 2].map((k) => `${NAMES[k]} sits out the first round`));
    expect(d.cards).toHaveLength(4);
    expect(d.cards.map((c) => c.label)).toEqual(["Quarter-final", "Semi-final 1", "Semi-final 2", "Final"]);
    expect(pairOf(d.cards[0]!.line)).toEqual(sorted(NAMES[3]!, NAMES[4]!));
    const semis = d.cards.filter((c) => c.label.startsWith("Semi-final")).map((c) => pairOf(c.line));
    expect(semis.sort()).toEqual([sorted(NAMES[0]!, "Winner of the quarter-final"), sorted(NAMES[1]!, NAMES[2]!)].sort());
    expect(d.cards.at(-1)).toEqual({ label: "Final", line: "Winners meet" });
  });

  it("6 sides: seeds 1-2 sit out; each meets the winner of the quarter-final the 8-draw sends them, named as its card is", () => {
    const d = drawPreview(cellOf(6), NAMES, msg);
    expect(d.sitsOut).toEqual([0, 1].map((k) => `${NAMES[k]} sits out the first round`));
    expect(d.cards).toHaveLength(5);
    expect(d.cards.map((c) => c.label)).toEqual(["Quarter-final 1", "Quarter-final 2", "Semi-final 1", "Semi-final 2", "Final"]);
    const qf = d.cards.filter((c) => c.label.startsWith("Quarter-final"));
    expect(qf.map((c) => pairOf(c.line)).sort()).toEqual([sorted(NAMES[2]!, NAMES[5]!), sorted(NAMES[3]!, NAMES[4]!)].sort());
    // A "winner of" seat names its feeding card by the card's own label (ruling m8): "Quarter-final 2" → "quarter-final 2".
    const feederOf = (a: string, b: string) => {
      const card = qf.find((c) => pairOf(c.line).join() === sorted(a, b).join());
      return `Winner of ${card!.label.replace(/^Quarter/, "quarter")}`;
    };
    const semis = d.cards.filter((c) => c.label.startsWith("Semi-final")).map((c) => pairOf(c.line));
    // Seed 1 meets the winner of 4v5 and seed 2 the winner of 3v6 (seed i v N+1−i in the 8-draw: 1v8→4v5, 2v7→3v6).
    expect(semis.sort()).toEqual(
      [
        sorted(NAMES[0]!, feederOf(NAMES[3]!, NAMES[4]!)),
        sorted(NAMES[1]!, feederOf(NAMES[2]!, NAMES[5]!)),
      ].sort(),
    );
    expect(d.cards.at(-1)).toEqual({ label: "Final", line: "Winners meet" });
  });

  it("a blank row is named by its place, never blank; no card ever reads a raw key or undefined (4 draws swept)", () => {
    const d = drawPreview(cellOf(4), ["Ravi & Sam", "", "Lee & Ana", "Jo & Max"], msg);
    expect(d.cards.some((c) => c.line.includes("Side 2"))).toBe(true);
    let cards = 0;
    for (let n = 3; n <= QUICK_MATCH_MAX_SIDES; n++) {
      for (const c of drawPreview(cellOf(n), NAMES.slice(0, n), msg).cards) {
        expect(`${c.label} ${c.line}`).not.toMatch(/undefined|\{|quickMatch\.|bracket\./);
        cards++;
      }
    }
    expect(cards).toBe(2 + 3 + 4 + 5);
  });

  it("refuses a seat fed by a match that is not in the draw (the guard, reached)", () => {
    const broken: QuickMatchKnockoutCell = {
      matchCount: 1,
      byes: [],
      rounds: [{ role: { kind: "final" }, pairs: [[{ seed: 1 }, { winnerOf: { round: 1, pair: 2 } }]] }],
    };
    expect(() => drawPreview(broken, NAMES, msg)).toThrow(/not in the draw/);
  });
});

describe("setupBody: the form's fields, exactly (C3 under the form-post contract)", () => {
  const base = {
    name: "Badminton · Tue, Nov 3",
    sport_key: "badminton",
    variant_key: "bwf",
    kind: "pair" as const,
    format: "league" as const,
    sides: ["A", "B", "C"],
    plays: 2,
    email: "",
    locale: "en" as const,
  };

  it("nine fields; sides repeated in typed order; a blank email is sent blank (the route maps it to none)", () => {
    const body = setupBody(base);
    expect([...new Set(body.keys())].sort()).toEqual(
      ["email", "format", "kind", "locale", "name", "plays", "sides", "sport_key", "variant_key"].sort(),
    );
    expect(body.getAll("sides")).toEqual(["A", "B", "C"]);
    expect(body.get("plays")).toBe("2");
    expect(body.get("email")).toBe("");
    expect(body.get("locale")).toBe("en");
  });

  it("a knockout sends plays 1, whatever was picked before it", () => {
    expect(setupBody({ ...base, format: "knockout", plays: 3 }).get("plays")).toBe("1");
  });
});

// ---- the island ---------------------------------------------------------------------------------------------------

describe("QuickMatchSetupForm: the screen as the mockup orders it", () => {
  it("opens on two side rows, no Format row (C16), Each pair plays standing alone, 2 of 6", () => {
    const i = mount();
    expect(sideInputs(i)).toHaveLength(2);
    expect(radio(i, "format", "league"), "no format choice at two sides").toBeUndefined();
    expect(radio(i, "format", "knockout")).toBeUndefined();
    expect(propsOf(hidden(i, "format")!).value).toBe("league");
    expect([1, 2, 3, 4].map((n) => radio(i, "plays", String(n)) !== undefined)).toEqual([true, true, true, true]);
    expect(i.text()).toContain("2 of 6");
    expect(i.text()).toContain("Each pair plays");
  });

  it("a third side brings the Format row with League and Knockout; six is the cap", () => {
    const i = mount();
    click(buttonNamed(i, "+ Add a side"));
    expect(sideInputs(i)).toHaveLength(3);
    expect(radio(i, "format", "league")).toBeDefined();
    expect(radio(i, "format", "knockout")).toBeDefined();
    expect(i.text()).toContain("3 of 6");
    fillSides(i, ["A", "B", "C", "D", "E", "F"]);
    expect(sideInputs(i)).toHaveLength(6);
    expect(buttonNamed(i, "+ Add a side"), "no add past six").toBeUndefined();
    expect(i.text()).toContain("6 of 6");
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

  it("Knockout hides Each pair plays and shows the draw from the server's table: 4 sides, two semi-finals and a final", () => {
    const i = mount();
    fillSides(i, ["Ravi & Sam", "Priya & Tom", "Lee & Ana", "Jo & Max"]);
    expect(startText(i)).toBe("Start playing · 6 matches");
    type(radio(i, "format", "knockout"), "knockout");
    expect(radio(i, "plays", "1"), "no plays choice in a knockout").toBeUndefined();
    expect(propsOf(hidden(i, "plays")!).value).toBe("1");
    const draw = byTestId(i, "qm-draw");
    expect(draw).toBeDefined();
    const text = textOf(draw!);
    expect(text).toContain("Semi-final 1");
    expect(text).toContain("Semi-final 2");
    expect(text).toContain("Winners meet");
    expect(i.text()).toContain("Lose and you're out.");
    expect(startText(i)).toBe("Start playing · 3 matches");
  });

  it("League again: the draw goes, Each pair plays comes back", () => {
    const i = mount();
    fillSides(i, ["A", "B", "C"]);
    type(radio(i, "format", "knockout"), "knockout");
    expect(byTestId(i, "qm-draw")).toBeDefined();
    type(radio(i, "format", "league"), "league");
    expect(byTestId(i, "qm-draw")).toBeUndefined();
    expect(radio(i, "plays", "2")).toBeDefined();
  });

  it("the sequence: Knockout, then down to two sides, then a third again: the format is League (reset), not Knockout", () => {
    const i = mount();
    fillSides(i, ["A", "B", "C"]);
    type(radio(i, "format", "knockout"), "knockout");
    expect(propsOf(radio(i, "format", "knockout")!).checked).toBe(true);
    click(buttonNamed(i, "Remove side 3"));
    expect(propsOf(hidden(i, "format")!).value).toBe("league");
    click(buttonNamed(i, "+ Add a side"));
    expect(propsOf(radio(i, "format", "league")!).checked).toBe(true);
    expect(propsOf(radio(i, "format", "knockout")!).checked).toBe(false);
  });

  it("the Start count follows the table: singular at one match, plays multiply, two sides is one match", () => {
    const i = mount();
    fillSides(i, ["A", "B"]);
    expect(startText(i)).toBe("Start playing · 1 match");
    type(radio(i, "plays", "3"), "3");
    expect(startText(i)).toBe("Start playing · 3 matches");
    fillSides(i, ["A", "B", "C", "D"]);
    expect(startText(i)).toBe("Start playing · 18 matches"); // 3 × 4·3/2
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

  it("the kind words are the dictionary's (Singles / Doubles), never the engine's", () => {
    const i = mount();
    const kindLabels = all(i)
      .filter((el) => el.type === "label" && walk(propsOf(el).children as ReactElement).some((c) => propsOf(c).name === "kind"))
      .map((el) => textOf(el).trim());
    expect(kindLabels).toEqual(["Singles", "Doubles"]);
  });
});

describe("Knockout unavailable (D15, spec §5): League alone and one line, no disabled button", () => {
  const level = () => {
    const sports = setupSports(LEVEL_OFFER, enUi) as SetupFormProps["sports"];
    return mount({ sports });
  };

  it("a variant that can end level, 3 sides: League alone, the reason, no Knockout control at all", () => {
    const i = level();
    const select = () => all(i).find((el) => el.type === "select" && propsOf(el).name === "variant_key")!;
    type(select(), "youth");
    fillSides(i, ["A", "B", "C"]);
    expect(i.text()).toContain("Knockout needs match rules that can't end level.");
    expect(radio(i, "format", "knockout")).toBeUndefined();
    expect(all(i).some((el) => el.type === "button" && textOf(el).includes("Knockout"))).toBe(false);
    expect(propsOf(hidden(i, "format")!).value).toBe("league");
  });

  it("the sequence: Knockout chosen on rules that allow it, then rules that do not: back to League; then back: Knockout offered", () => {
    const i = level();
    const select = () => all(i).find((el) => el.type === "select" && propsOf(el).name === "variant_key")!;
    fillSides(i, ["A", "B", "C"]);
    type(radio(i, "format", "knockout"), "knockout");
    type(select(), "youth");
    expect(propsOf(hidden(i, "format")!).value).toBe("league");
    type(select(), "11-a-side");
    expect(radio(i, "format", "knockout"), "positive pair: offered again").toBeDefined();
    expect(propsOf(radio(i, "format", "league")!).checked).toBe(true);
    expect(i.text()).not.toContain("Knockout needs match rules");
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
      format: ["league"],
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
      /** The controller's ruling, typed: the copy is the contract. */
      const TICK_LINE = "Tick the check above, then tap Start.";
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

  it("a knockout posts format knockout and plays 1; chess posts kind individual", async () => {
    const { calls } = stubFetch([{ url: "http://localhost:3000/q/qm_ko", status: 200 }]);
    const i = mount();
    type(radio(i, "sport_key", "boardgame"), "boardgame");
    fillSides(i, ["A", "B", "C", "D"]);
    type(radio(i, "plays", "2"), "2");
    type(radio(i, "format", "knockout"), "knockout");
    await submit(i);
    const body = calls[0]!.init.body as URLSearchParams;
    expect(body.get("format")).toBe("knockout");
    expect(body.get("plays")).toBe("1");
    expect(body.get("kind")).toBe("individual");
    expect(body.get("sport_key")).toBe("boardgame");
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

  it("every tap target has a 44px floor of its own, and no element carries two text sizes or two vertical paddings; 19 checked", () => {
    const i = mount({}, { hydrate: true });
    fillSides(i, ["A", "B", "C"]); // a × and the Format row
    const faces = (name: string) =>
      all(i)
        .filter((el) => el.type === "label" && walk(propsOf(el).children as ReactElement).some((c) => propsOf(c).name === name))
        .map((label) => walk(propsOf(label).children as ReactElement).find((c) => c.type === "span")!);
    const targets: [string, ReactElement][] = [
      ...faces("sport_key").map((el): [string, ReactElement] => ["chip", el]),
      ...faces("kind").map((el): [string, ReactElement] => ["kind", el]),
      ...faces("plays").map((el): [string, ReactElement] => ["plays", el]),
      ...faces("format").map((el): [string, ReactElement] => ["format", el]),
      ...sideInputs(i).map((el): [string, ReactElement] => ["side", el]),
      ["remove", buttonNamed(i, "Remove side 3")!],
      ["add", buttonNamed(i, "+ Add a side")!],
      ["rules", all(i).find((el) => el.type === "select")!],
      ["email", all(i).find((el) => el.type === "summary")!],
    ];
    for (const [what, el] of targets) {
      const cls = classOf(el).split(/\s+/);
      const floor = cls.includes("min-h-11") || (cls.includes("h-11") && cls.includes("w-11"));
      expect(floor, `${what}: ${classOf(el)}`).toBe(true);
      expect(cls.filter((c) => /^text-(xs|sm|base|lg|xl)$/.test(c)).length, `${what}: one text size`).toBeLessThanOrEqual(1);
      expect(cls.filter((c) => /^py-/.test(c)).length, `${what}: one vertical padding`).toBeLessThanOrEqual(1);
    }
    // 4 chips, 2 kinds, 4 plays, 2 formats, 3 sides, ×, Add, rules, email.
    expect(targets).toHaveLength(19);
  });

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

  it("the sits-out lines wrap, and two sides of the same name still make two lines (index keys)", () => {
    const i = mount({}, { hydrate: true });
    fillSides(i, ["Ana", "Ana", "Ana", "Ana", "Ana"]);
    type(radio(i, "format", "knockout"), "knockout");
    const lines = all(i).filter((el) => el.type === "li" && textOf(el).includes("sits out"));
    expect(lines.map((el) => textOf(el))).toEqual(["Ana sits out the first round", "Ana sits out the first round", "Ana sits out the first round"]);
    expect(new Set(lines.map((el) => el.key)).size, "three distinct keys").toBe(3);
    for (const el of lines) expect(classOf(el).split(/\s+/)).toEqual(expect.arrayContaining(["min-w-0", "break-words"]));
  });
});
