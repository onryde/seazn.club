// Review a (PR #974): at R2007's 30 px floor a crease line ran out of band, and the ONE ellipsis label
// `${name} ${figures}` cut the FIGURES ("Bowl 11 … 0.3-0-…") while the name stayed whole. A number is the fact a
// broadcast graphic exists to carry — a name may yield, a figure never does.
//
// The node-provable half: the crease line reaches the renderers as people (name, striker mark, figures), the bar draws
// each as a NAME box that can ellipse beside FIGURES boxes that cannot, and the stylesheet declares that. The lines come
// from the REAL `cricketDetail` over a ledger folded by the REAL engine — never a typed fixture of what a crease looks
// like. The layout half (the name yields, the figures stay whole and inside the band, at every frame) is
// `e2e/overlay-gallery.spec.ts` check 8, which reads it in a browser.
//
// And the bug (same review, same cause): its 512 px footer at the 30 px floor cannot hold a crease PAIR's figures
// beside the chase, let alone the bowler's analysis and this over's glyphs. The pair, the bowler and the glyphs are the
// BAR band's content (the W2 plan: "The cricket bar's second band carries the batters at the crease and the bowler's
// figures"). R2005 change 12 (owner, 2026-10-18) gives the bug back the STRIKER alone — one batter's figures fit whole
// beside the chase where a pair's did not — so the bug draws the chase or result and the striker, never the pair.
// `bug-striker-line.test.tsx` owns the striker line's own rules; this file keeps the "never the pair" half.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cricket, deriveCricketScorecard } from "@seazn/engine/sports/cricket";
import { defaultLineupPair, makeEnvelope, SIM_CONFIGS } from "@seazn/engine/testkit";
import { propsOf, textOf, walk } from "@/components/__tests__/_hook-harness";
import { cricketDetail, liveFromScorecard } from "@/lib/overlay-cricket";
import { nameLadder, type OverlayModel, type OverlayMsg } from "@/lib/overlay-model";
import { OverlayBar } from "../overlay-bar";
import { OverlayBug } from "../overlay-bug";
import { OverlayEndOfOverCard } from "../overlay-end-of-over";
import type { ReactElement } from "react";

const msg: OverlayMsg = (key) => (key === "overlay.cricket.strikerMark" ? "*" : key);

const NAMES: Record<string, string> = {
  "H-p1": "Venkataraman Subramanian",
  "H-p2": "Kohli",
  "H-p3": "Jean-Sébastien Tremblay-Desrosiers",
  "A-p11": "Mohammad Saifuddin Chowdhury",
};

const cfg = (cricket as unknown as { configSchema: { parse: (r: unknown) => unknown } }).configSchema.parse(
  SIM_CONFIGS["cricket"] ?? {},
);
const lineups = defaultLineupPair(cricket.positions);
const base = { over: 0, ballInOver: 1, striker: "H-p1", nonStriker: "H-p2", bowler: "A-p11" };
/** A single, a four, then a wicket — so the crease holds an incoming striker and a batter with runs. */
const LEDGER = [
  makeEnvelope(1, { type: "cricket.toss", payload: { wonBy: "H", elected: "bat" } } as never),
  makeEnvelope(2, { type: "core.start", payload: {} } as never),
  makeEnvelope(3, { type: "cricket.ball", payload: { ...base, runs: { bat: 1 } } } as never),
  makeEnvelope(4, {
    type: "cricket.ball",
    payload: { ...base, ballInOver: 2, striker: "H-p2", nonStriker: "H-p1", runs: { bat: 4 }, boundary: 4 },
  } as never),
  makeEnvelope(5, {
    type: "cricket.ball",
    payload: {
      ...base,
      ballInOver: 3,
      striker: "H-p2",
      nonStriker: "H-p1",
      runs: { bat: 0 },
      wicket: { kind: "bowled", out: "H-p2", bowlerCredited: true, incoming: "H-p3" },
    },
  } as never),
];
const scorecard = deriveCricketScorecard({ events: LEDGER as never, cfg: cfg as never, lineups });
const lines = cricketDetail(liveFromScorecard(scorecard, (id) => NAMES[id]), msg);

const MODEL: OverlayModel = {
  live: true,
  decided: false,
  voided: false,
  header: { context: "overlay.header.live", period: "" },
  sides: [
    { short: "ASH", name: "Ashgrove Rovers", ladder: nameLadder({ id: "h", name: "Ashgrove Rovers" }, "ASH"), big: "5/1", led: true, serving: false },
    { short: "NOR", name: "Northbridge Athletic", ladder: nameLadder({ id: "a", name: "Northbridge Athletic" }, "NOR"), big: "", led: false, serving: false },
  ],
  cellsKind: "none",
  cells: [],
  detail: lines,
};

const render = (Component: typeof OverlayBar | typeof OverlayBug, model: OverlayModel) =>
  walk(Component({ model, tick: [false, false], msg }));
/** Strings concatenated as the DOM does (`textOf` joins with spaces, which is not what a reader hears). */
const rawText = (node: unknown): string => {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(rawText).join("");
  return rawText(propsOf(node as ReactElement).children);
};
const cls = (el: ReactElement) => (propsOf(el).className as string | undefined) ?? "";
const ofClass = (tree: ReactElement[], c: string) => tree.filter((el) => cls(el).split(" ").includes(c));

const GLOBALS_CSS = join(__dirname, "..", "..", "..", "app", "globals.css");
const ruleBody = (selector: string): string => {
  const escaped = selector.replace(/[.[\]]/g, "\\$&");
  const m = readFileSync(GLOBALS_CSS, "utf8").match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  return m ? m[1]! : "";
};

describe("the crease reaches the renderers as people: a name, a striker mark, and figures", () => {
  it("premise: the real fold names a striker, a partner and a bowler, each with figures", () => {
    const people = lines.flatMap((l) => l.people ?? []);
    console.log(`crease lines: ${lines.length}, people: ${people.length}`);
    expect(lines.length).toBe(2);
    expect(people.map((p) => p.name)).toEqual([NAMES["H-p3"], NAMES["H-p1"], NAMES["A-p11"]]);
    expect(lines.every((l) => l.crease === true), "every cricket line is marked as the crease's").toBe(true);
  });
});

describe("the bar draws each person as a NAME that may ellipse beside FIGURES that may not", () => {
  const tree = render(OverlayBar, MODEL);
  const people = lines.flatMap((l) => l.people ?? []);

  it("one name box and one figures box per person, the figures the engine's own, never inside the name", () => {
    const names = ofClass(tree, "ovl-detail-name");
    const figures = ofClass(tree, "ovl-detail-figures");
    console.log(`people checked: ${people.length}, name boxes: ${names.length}, figures boxes: ${figures.length}`);
    expect(people.length, "anti-vacuity").toBeGreaterThan(0);
    expect(names.map((n) => textOf(n))).toEqual(people.map((p) => p.name));
    expect(figures.map((f) => textOf(f))).toEqual(people.map((p) => p.figures));
    // The figures are the ENGINE's: the bowler's O-M-R-W off the folded scorecard, and the partner's runs (balls).
    const bowl = scorecard.innings.at(-1)!.bowling.find((b) => b.person === "A-p11")!;
    const partner = scorecard.innings.at(-1)!.batting.find((b) => b.person === "H-p1")!;
    expect(textOf(figures[2]!)).toBe(`${bowl.overs}-${bowl.maidens}-${bowl.runs}-${bowl.wickets}`);
    expect(textOf(figures[1]!)).toBe(`${partner.runs} (${partner.balls})`);
    for (const n of names) expect(walk(propsOf(n).children as never).some((el) => cls(el).includes("figures"))).toBe(false);
  });

  it("the striker's mark is its own box, so a name that yields never takes the mark with it", () => {
    const marks = ofClass(tree, "ovl-detail-mark");
    expect(marks.map((m) => textOf(m))).toEqual(["*"]);
    expect(ofClass(tree, "ovl-detail-name").some((n) => textOf(n).includes("*"))).toBe(false);
  });

  // Confirm pass, PR #974 (coordinator ruling, owner may override at sign-off): the mark is the STRIKER's
  // (overlay.cricket.strikerMark), and every batter at the crease is not out — so a mark AFTER the name drifts toward
  // the figures ("Fuji… * 31") and reads as the not-out "31*". And it can never hug an ellipsis: `text-overflow`
  // truncates whole glyphs, so the glyph that did not fit leaves empty slack inside the name's box. The mark LEADS the
  // name instead, the pad's own on-strike treatment (`▸${strikerName}`, skins/cricket.tsx): it shares one box with the
  // name (`.ovl-detail-who`), sits at the name's START edge, and the name stands between it and the figures. The browser
  // half is the gallery's check 8.
  it("the mark LEADS its name: one who-box holds the mark then the name, and never the figures", () => {
    const whos = ofClass(tree, "ovl-detail-who");
    console.log(`who boxes checked: ${whos.length}, people: ${people.length}`);
    expect(whos.length, "one who-box per person").toBe(people.length);
    let marked = 0;
    whos.forEach((who, i) => {
      const inside = walk(propsOf(who).children as never).map(cls);
      expect(inside, `who-box ${i} holds its name`).toContain("ovl-detail-name");
      expect(inside.some((c) => c.includes("ovl-detail-figures")), `who-box ${i} holds no figures`).toBe(false);
      if (people[i]!.mark !== undefined) {
        marked++;
        expect(inside, `who-box ${i}: the striker's mark first, then the name`).toEqual(["ovl-detail-mark", "ovl-detail-name"]);
      } else {
        expect(inside, `who-box ${i}: no mark for a non-striker`).toEqual(["ovl-detail-name"]);
      }
    });
    expect(marked, "anti-vacuity: the striker was checked").toBe(1);
  });

  it("the end-of-over card leads its striker with the same mark (one striker vocabulary on one frame)", () => {
    const closed = {
      inningsIndex: 0,
      over: 12,
      runs: 8,
      wickets: 1,
      score: "142/6",
      glyphs: [{ kind: "runs", runs: 1 }],
      bowler: { name: "Bumrah", overs: "4.0", maidens: 0, runs: 28, wickets: 2 },
      batters: [
        { name: "Iyer", runs: 40, balls: 24, onStrike: true },
        { name: "Pant", runs: 12, balls: 8, onStrike: false },
      ],
    };
    const card = walk(
      OverlayEndOfOverCard({
        moment: { seq: 1, kind: "endOfOver", graphic: "endOfOver", holdMs: 1, tone: "led", headline: "End of over 12", endOfOver: closed } as never,
        phase: "in" as never,
        msg,
      }),
    );
    const batters = ofClass(card, "ovl-end-of-over-batter").map(rawText);
    expect(batters, "both batters read").toHaveLength(2);
    expect(batters).toEqual([`${msg("overlay.cricket.strikerMark")}Iyer 40 (24)`, "Pant 12 (8)"]);
  });

  it("no crease text rides in an ellipsis LABEL any more, and each entry reads exactly its line's text", () => {
    const entries = ofClass(tree, "ovl-detail-entry");
    expect(entries.length).toBe(lines.length);
    expect(ofClass(tree, "ovl-detail-label").map((l) => textOf(l))).toEqual([]);
    entries.forEach((entry, i) => expect(rawText(entry)).toBe(lines[i]!.text));
    // The entry carries the floor modifier: its minimum is its figures, not zero.
    for (const entry of entries) expect(cls(entry).split(" ")).toContain("ovl-detail-entry--figures");
  });

  it("a non-crease line keeps its label and no figures floor (hockey's strength and cards are unchanged)", () => {
    const hockey = render(OverlayBar, { ...MODEL, detail: [{ text: "11v8" }, { text: "AWA Red card", tone: "dismissal" }] });
    expect(ofClass(hockey, "ovl-detail-label").map((l) => textOf(l))).toEqual(["11v8", "AWA Red card"]);
    expect(ofClass(hockey, "ovl-detail-entry--figures")).toEqual([]);
  });
});

describe("the bug draws the chase and the striker — never the crease pair (R2005 change 12)", () => {
  const strikerName = (lines[0]!.people ?? []).find((p) => p.mark !== undefined)!.name;
  const otherNames = [
    ...(lines[0]!.people ?? []).filter((p) => p.mark === undefined).map((p) => p.name),
    ...(lines[1]?.people ?? []).map((p) => p.name),
  ];

  it("the ledger's crease is a pair and a bowler (so 'only the striker' is a real narrowing)", () => {
    expect(lines[0]!.people, "a pair at the crease").toHaveLength(2);
    expect(otherNames.length, "a non-striker and a bowler to leave out").toBeGreaterThanOrEqual(2);
  });

  it("cricket live on the bug: the chase leads, then ONE person — the striker; the pair and the bowler are the bar's", () => {
    const tree = render(OverlayBug, { ...MODEL, chase: "Need 45 off 30" });
    console.log(`bug entries: ${ofClass(tree, "ovl-detail-entry").length}`);
    expect(textOf(tree.find((el) => propsOf(el)["data-testid"] === "ovl-chase")!)).toBe("Need 45 off 30");
    expect(ofClass(tree, "ovl-detail-entry")).toHaveLength(1);
    expect(ofClass(tree, "ovl-detail-name").map((n) => textOf(n))).toEqual([strikerName]);
    expect(ofClass(tree, "ovl-detail-figures")).toHaveLength(1);
    const text = textOf(tree.find((el) => propsOf(el)["data-testid"] === "ovl-detail")!);
    for (const name of otherNames) expect(text, name).not.toContain(name);
  });

  it("with nothing but the crease to say, the footer is the striker alone", () => {
    const tree = render(OverlayBug, MODEL);
    expect(tree.filter((el) => propsOf(el)["data-testid"] === "ovl-detail")).toHaveLength(1);
    expect(ofClass(tree, "ovl-detail-entry").map((e) => textOf(ofClass(walk(e), "ovl-detail-name")[0]!))).toEqual([strikerName]);
  });

  it("a non-crease line still reaches the bug, after the striker (the filter is the crease's, not the detail list's)", () => {
    const tree = render(OverlayBug, { ...MODEL, detail: [...lines, { text: "AWA Red card", tone: "dismissal" }] });
    const entries = ofClass(tree, "ovl-detail-entry");
    expect(entries).toHaveLength(2);
    expect(textOf(entries[1]!)).toContain("AWA Red card");
  });
});

describe("the stylesheet: a name yields, figures never do", () => {
  it(".ovl-detail-name carries the three properties an ellipsis needs", () => {
    const rule = ruleBody(".ovl-detail-name");
    expect(rule).toMatch(/min-width:\s*0/);
    expect(rule).toMatch(/overflow:\s*hidden/);
    expect(rule).toMatch(/text-overflow:\s*ellipsis/);
  });

  it("a person is a grid whose NAME column has a zero minimum — so its own minimum is its mark and figures", () => {
    const rule = ruleBody(".ovl-detail-person");
    expect(rule).toMatch(/display:\s*inline-grid/);
    expect(rule).toMatch(/grid-template-columns:\s*minmax\(0,\s*max-content\)/);
  });

  it("the who-box shrinks with its name and the mark never does, so the mark sits on the name's edge", () => {
    const who = ruleBody(".ovl-detail-who");
    expect(who).toMatch(/display:\s*inline-flex/);
    expect(who).toMatch(/min-width:\s*0/);
    expect(ruleBody(".ovl-detail-mark")).toMatch(/flex:\s*none/);
    // The overlay's indicator colour — the serve dot's and the LED bar's (`--sport-led`), never a hard-coded hex.
    expect(ruleBody(".ovl-detail-mark")).toMatch(/color:\s*var\(--sport-led\)/);
  });

  it("the striker mark is one glyph, the same in every locale, and never the not-out star", () => {
    const root = join(__dirname, "..", "..", "..", "dictionaries");
    const marks = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => (JSON.parse(readFileSync(join(root, d.name, "public.json"), "utf8")) as Record<string, string>)["overlay.cricket.strikerMark"]);
    console.log(`locales checked: ${marks.length}, marks: ${JSON.stringify(marks)}`);
    expect(marks.length, "anti-vacuity: every locale").toBeGreaterThanOrEqual(4);
    expect(new Set(marks).size, "one glyph in every locale").toBe(1);
    expect([...marks[0]!], "a single glyph").toHaveLength(1);
    expect(marks[0], "never the not-out star").not.toBe("*");
  });

  it("an entry holding figures keeps its content minimum (min-width: auto), where a label entry's is zero", () => {
    expect(ruleBody(".ovl-detail-entry")).toMatch(/min-width:\s*0/);
    expect(ruleBody(".ovl-detail-entry--figures")).toMatch(/min-width:\s*auto/);
  });
});
