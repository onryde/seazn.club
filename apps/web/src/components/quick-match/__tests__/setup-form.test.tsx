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
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import enMarketing from "@/dictionaries/en/marketing.json";
import enUi from "@/dictionaries/en/ui.json";
import { QUICK_MATCH_ERRORS, QUICK_MATCH_MAX_PLAYS, QUICK_MATCH_MAX_SIDES } from "@/lib/quick-match-constants";
import {
  quickMatchPreviewTable,
  type QuickMatchKnockoutCell,
  type QuickMatchPreviewTable,
} from "@/server/usecases/quick-match-preview";
import type { QuickMatchSport } from "@/server/usecases/quick-match-sports";
import { propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";
import { setupCopy, setupSports } from "@/app/[lang]/(marketing)/play/setup-props";
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
  // T3 report, "Map the codes": five codes have their own line; CREATE_FAILED and every other code read the generic one.
  const OWN: Record<string, string> = {
    QUICK_MATCH_TOO_MANY_ALIVE: "quickMatch.errors.tooManyAlive",
    QUICK_MATCH_RATE_LIMITED: "quickMatch.errors.rateLimited",
    QUICK_MATCH_SPORT_NOT_OFFERED: "quickMatch.errors.sportNotOffered",
    QUICK_MATCH_KIND_NOT_OFFERED: "quickMatch.errors.kindNotOffered",
    QUICK_MATCH_FORMAT_NOT_OFFERED: "quickMatch.errors.formatNotOffered",
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

  it("6 sides: seeds 1-2 sit out; each meets the winner of the quarter-final the 8-draw sends them, named by match number", () => {
    const d = drawPreview(cellOf(6), NAMES, msg);
    expect(d.sitsOut).toEqual([0, 1].map((k) => `${NAMES[k]} sits out the first round`));
    expect(d.cards).toHaveLength(5);
    expect(d.cards.map((c) => c.label)).toEqual(["Quarter-final 1", "Quarter-final 2", "Semi-final 1", "Semi-final 2", "Final"]);
    const qf = d.cards.filter((c) => c.label.startsWith("Quarter-final"));
    expect(qf.map((c) => pairOf(c.line)).sort()).toEqual([sorted(NAMES[2]!, NAMES[5]!), sorted(NAMES[3]!, NAMES[4]!)].sort());
    // Round one is played first, so quarter-final k is match k (D12's numbering: the 1-based index in play order).
    const matchOf = (a: string, b: string) => {
      const card = qf.find((c) => pairOf(c.line).join() === sorted(a, b).join());
      return Number(card!.label.replace("Quarter-final ", ""));
    };
    const semis = d.cards.filter((c) => c.label.startsWith("Semi-final")).map((c) => pairOf(c.line));
    // Seed 1 meets the winner of 4v5 and seed 2 the winner of 3v6 (seed i v N+1−i in the 8-draw: 1v8→4v5, 2v7→3v6).
    expect(semis.sort()).toEqual(
      [
        sorted(NAMES[0]!, `Winner of match ${matchOf(NAMES[3]!, NAMES[4]!)}`),
        sorted(NAMES[1]!, `Winner of match ${matchOf(NAMES[2]!, NAMES[5]!)}`),
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

  it("Start is disabled while any row is blank or the name is cleared, enabled once every row is filled", () => {
    const i = mount();
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
    vi.stubGlobal("window", { location: { assign } });
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
    vi.stubGlobal("window", { location: { assign: vi.fn() } });
    const i = mount();
    fillSides(i, ["A", "B"]);
    // Both taps reach the SAME handler, as two events dispatched before React re-renders do: only the lock stops the
    // second (the disabled button and the stale `canStart` both still read "ready" in that closure).
    const onSubmit = propsOf(all(i).find((el) => el.type === "form")!).onSubmit as (e: { preventDefault(): void }) => Promise<void>;
    const first = onSubmit({ preventDefault: () => {} });
    const second = onSubmit({ preventDefault: () => {} });
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

  it("the form is a real post to the create route, so it works before the script loads", () => {
    const form = all(mount()).find((el) => el.type === "form")!;
    expect(propsOf(form).method).toBe("post");
    expect(propsOf(form).action).toBe("/api/quick-match");
    expect(propsOf(hidden(mount({ lang: "nl" }), "locale")!).value).toBe("nl");
  });
});

