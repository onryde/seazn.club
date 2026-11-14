// Quick match League + Knockout sign-off (qlk14s1, 2026-11-14): four places a 43-character side name broke the layout.
//
//   1. The champion's name, set large, split mid-word at 320 ("FEATHERSTONEHAUG / H-BRAY"): its longest unbreakable run did
//      not fit the card at 2rem. The type now shrinks to fit that run (the card is a size container), never past a floor.
//   2. A knockout card's seat row wrapped the rank note or the winner's score under a truncated long name, so two sibling
//      cards' Score buttons sat at different heights. The name now gives up width before the note does, and the card's
//      actions sit at its foot, so the cards of one row line up whatever their seats hold.
//   3. The Full table capped the name at 10rem even at 1280. The cap stays on a phone (the table scrolls sideways there);
//      from md the name takes the room the numbers leave, never less than 10rem.
//   4. A league row still to play broke a long name mid-word beside its Score and ⋯. A named seat now truncates.
//
// `apps/web` vitest has no DOM, so what is pinned here is the WIRING the browser needs (the classes, the custom property,
// that the arbitrary values compile to real CSS); the sign-off capture measured the rendering at 320, 768 and 1280.
// Expected run lengths are counted by hand from CSS line breaking (a line breaks at a space and after a hyphen), never read
// back from the helper.
//
// Sport: not applicable (names and layout; no sport rule is read here).
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { compileClasses } from "@/components/v2/__tests__/_compiled-css";
import { championCard } from "../home";
import { QuickMatchDraw, type DrawCard, type DrawSeat } from "../draw";
import { QuickMatchList, type MatchView, type SeatView } from "../match-list";
import { QuickMatchFullTable, type StandingsView } from "../standings";
import { longestUnbreakableRun } from "../name-fit";

const LONG = "Maximiliana Ottoline Featherstonehaugh-Bray";

// ── a server tree, expanded ──────────────────────────────────────────────────────────────────────────────────────────

type El = ReactElement<Record<string, unknown>>;
/** Every component here is a server component with no hooks: call it, keep host elements, expand their children. */
function expand(node: ReactNode): ReactNode {
  if (Array.isArray(node)) return node.map((n) => expand(n as ReactNode));
  if (!isValidElement(node)) return node;
  const el = node as El;
  if (typeof el.type === "function") return expand((el.type as (p: unknown) => ReactNode)(el.props));
  const children = el.props.children === undefined ? undefined : expand(el.props.children as ReactNode);
  return { ...el, props: { ...el.props, children } } as El;
}
function all(node: unknown, pred: (el: El) => boolean, out: El[] = []): El[] {
  if (Array.isArray(node)) for (const n of node) all(n, pred, out);
  else if (isValidElement(node)) {
    const el = node as El;
    if (pred(el)) out.push(el);
    all(el.props.children, pred, out);
  }
  return out;
}
const byTestId = (tree: ReactNode, id: string) => all(tree, (el) => el.props["data-testid"] === id);
function textOf(node: unknown): string {
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (isValidElement(node)) return textOf((node.props as { children?: unknown }).children);
  return "";
}
const tokens = (el: El): string[] => String(el.props.className ?? "").split(/\s+/).filter(Boolean);

// ── 1. the champion's name ───────────────────────────────────────────────────────────────────────────────────────────

const FIT = "text-[length:clamp(1.25rem,calc(100cqi/var(--qm-name-run)/0.55),2rem)]";

describe("the longest run a line cannot break inside (CSS line breaking: at a space, and after a hyphen)", () => {
  it("the empty case first: a blank name is a run of 1, never 0 (the type divides by it)", () => {
    expect(longestUnbreakableRun("")).toBe(1);
    expect(longestUnbreakableRun("   ")).toBe(1);
  });

  it("counted by hand: the hyphen ends a run, so the 43-character name's longest is “Featherstonehaugh-” (18)", () => {
    const cases: [string, number][] = [
      [LONG, 18], // Maximiliana 11 · Ottoline 8 · Featherstonehaugh- 18 · Bray 4
      ["Priya Raman", 5],
      ["Ines Duarte", 6],
      ["Jean-Luc Picard", 6], // Jean- 5 · Luc 3 · Picard 6
      ["  Oskar   Lind ", 5], // runs of spaces are one break
      ["Chloé Martin", 6], // é is one character, not two
      ["Featherstonehaugh", 17], // no hyphen: the whole word
    ];
    let checked = 0;
    for (const [name, run] of cases) {
      expect(longestUnbreakableRun(name), name).toBe(run);
      checked++;
    }
    expect(checked, "names checked").toBe(7);
  });

  it("the champion card is a size container and its name carries its run (a long name and a short one)", () => {
    let checked = 0;
    for (const [name, run] of [[LONG, 18], ["Priya Raman", 5]] as const) {
      const tree = expand(championCard({ kicker: "Champion", name, beat: null, topToo: null }));
      const [card] = byTestId(tree, "qm-champion");
      expect(tokens(card!), "the card is the container the name's cqi reads").toContain("@container");
      const [el] = byTestId(tree, "qm-champion-name");
      expect(textOf(el)).toBe(name);
      expect(tokens(el!), name).toContain(FIT);
      // The old fixed size is gone: with it beside the fit, whichever Tailwind sorts last would win.
      expect(tokens(el!).some((c) => c === "text-[2rem]"), name).toBe(false);
      // Overflow-wrap stays as the last resort: only a single run too long even at the floor breaks inside.
      expect(tokens(el!), name).toContain("[overflow-wrap:anywhere]");
      expect((el!.props.style as Record<string, unknown>)["--qm-name-run"], name).toBe(run);
      checked++;
    }
    expect(checked).toBe(2);
  });
});

// ── 2. the knockout's cards ──────────────────────────────────────────────────────────────────────────────────────────

const seat = (name: string, extra: Partial<DrawSeat> = {}): DrawSeat => ({ name, label: name, winner: false, ...extra });
const waiting = (label: string): DrawSeat => ({ name: null, label, winner: false });
const card = (id: string, home: DrawSeat, away: DrawSeat, extra: Partial<DrawCard> = {}): DrawCard => ({
  id, round: "Semi-final", bye: false, isFinal: false, live: false, home, away, score: null, ...extra,
});
const NAME_FLOOR = "min-w-[min(100%,5rem)]";

function drawTree(cards: DrawCard[], final: DrawCard, lk: boolean) {
  return expand(
    <QuickMatchDraw
      title="Knockout"
      rounds={[{ roundNo: 1, cards }, { roundNo: 2, cards: [final] }]}
      byeLabel="Bye"
      liveLabel="Live"
      leagueKnockout={
        lk
          ? {
              caption: null,
              score: (f) => <button data-testid="qm-score" data-fixture={f.id} />,
              rowMenu: (r) => <button data-testid="qm-row-menu-toggle" data-fixture={r.fixtureId} />,
            }
          : undefined
      }
    />,
  );
}

describe("a knockout card: the name gives up width first, and the card's actions sit at its foot", () => {
  it("semi-finals filled (a rank note beside each seat): every named seat truncates on one line with its note beside it", () => {
    const sf1 = card("sf1", seat("Ines Duarte", { note: "1st" }), seat("Ravi Menon", { note: "4th" }), { next: true, play: { live: false } });
    const sf2 = card("sf2", seat("Oskar Lind", { note: "3rd" }), seat(LONG, { note: "2nd" }), { play: { live: false } });
    const final = card("f", waiting("Winner of semi-final 1"), waiting("Winner of semi-final 2"), { isFinal: true, round: "Final" });
    const tree = drawTree([sf1, sf2], final, true);

    const named = byTestId(tree, "qm-draw-name").filter((el) => textOf(el) !== "" && !textOf(el).startsWith("Winner of"));
    expect(named.map(textOf)).toEqual(["Ines Duarte", "Ravi Menon", "Oskar Lind", LONG]);
    for (const el of named) {
      // A zero basis that grows: the name never pushes its note onto a line of its own, and keeps at least 5rem.
      expect(tokens(el), textOf(el)).toEqual(expect.arrayContaining(["flex-1", NAME_FLOOR, "truncate"]));
      expect(tokens(el), textOf(el)).not.toContain("max-w-full");
    }
    // The waiting seats wrap their words (review m4), never truncate: the negative pair of the rule above.
    const waits = byTestId(tree, "qm-draw-name").filter((el) => textOf(el).startsWith("Winner of"));
    expect(waits).toHaveLength(2);
    for (const el of waits) {
      expect(tokens(el)).toContain("break-words");
      expect(tokens(el)).not.toContain("truncate");
    }
    expect(byTestId(tree, "qm-draw-note").map(textOf)).toEqual(["1st", "4th", "3rd", "2nd"]);
  });

  it("every card is a column whose actions sit at its foot: Score on both semis lines up, whatever the seats hold", () => {
    const sf1 = card("sf1", seat("Ines Duarte", { note: "1st" }), seat("Ravi Menon", { note: "4th" }), { play: { live: false } });
    const sf2 = card("sf2", seat("Oskar Lind", { note: "3rd" }), seat(LONG, { note: "2nd · by lot" }), { play: { live: false } });
    const final = card("f", waiting("Winner of semi-final 1"), waiting("Winner of semi-final 2"), { isFinal: true, round: "Final" });
    const tree = drawTree([sf1, sf2], final, true);
    const cards = byTestId(tree, "qm-draw-card");
    expect(cards).toHaveLength(3);
    for (const c of cards) expect(tokens(c), String(c.props["data-fixture-id"])).toEqual(expect.arrayContaining(["flex", "flex-col"]));
    const actions = byTestId(tree, "qm-draw-actions");
    expect(actions, "both semis carry a Score; the waiting final none").toHaveLength(2);
    for (const a of actions) {
      expect(tokens(a)).toContain("mt-auto");
      expect(tokens(a), "a fixed top margin would hang the row under the content again").not.toContain("mt-2");
    }
  });

  it("after the semis (a winner's score on the line, another sport's long score): the seat keeps the same name rule", () => {
    // Chess writes "1–0"; badminton writes the games, "11–9 · 8–11 · 11–7" (sign-off section 18), which may drop under the
    // name in a half-width card: the floor decides, and the foot-aligned actions keep the row lined up either way.
    const sf1 = card("sf1", seat("Ines Duarte", { winner: true, score: "1–0" }), seat("Ravi Menon"), { edit: true });
    const sf2 = card("sf2", seat("Oskar Lind"), seat(LONG, { winner: true, score: "11–9 · 8–11 · 11–7" }), { edit: true });
    const final = card("f", seat("Ines Duarte"), seat(LONG), { isFinal: true, round: "Final", next: true, play: { live: false } });
    const tree = drawTree([sf1, sf2], final, true);
    const scores = byTestId(tree, "qm-draw-seat-score");
    expect(scores.map(textOf)).toEqual(["1–0", "11–9 · 8–11 · 11–7"]);
    const named = byTestId(tree, "qm-draw-name");
    expect(named).toHaveLength(6);
    for (const el of named) expect(tokens(el), textOf(el)).toEqual(expect.arrayContaining(["flex-1", NAME_FLOOR, "truncate"]));
    expect(byTestId(tree, "qm-draw-actions")).toHaveLength(3);
  });

  it("a plain Knockout (no Score or ⋯ on its cards) draws the same seats, and a card with nothing to offer has no actions row", () => {
    const sf1 = card("sf1", seat("Ines Duarte"), seat(LONG));
    const final = card("f", waiting("Winner of the semi-final"), seat("Oskar Lind"), { isFinal: true, round: "Final" });
    const tree = drawTree([sf1], final, false);
    expect(byTestId(tree, "qm-draw-actions")).toHaveLength(0);
    const named = byTestId(tree, "qm-draw-name").filter((el) => !textOf(el).startsWith("Winner of"));
    expect(named.map(textOf)).toEqual(["Ines Duarte", LONG, "Oskar Lind"]);
    for (const el of named) expect(tokens(el)).toEqual(expect.arrayContaining(["flex-1", NAME_FLOOR, "truncate"]));
  });
});

// ── 4. the league's rows ─────────────────────────────────────────────────────────────────────────────────────────────

const sv = (name: string): SeatView => ({ name, label: name, winner: false });
const row = (id: string, n: number, phase: MatchView["phase"], home: SeatView, away: SeatView, extra: Partial<MatchView> = {}): MatchView => ({
  id, n, phase, home, away, score: null, result: null, next: false, editable: false, skippable: false, putBack: false, skipCopy: null,
  ...extra,
});
const SEAT = ["inline-block", "max-w-full", "truncate", "align-bottom", "font-semibold"];

describe("a league row: a named seat truncates with an ellipsis, never breaks mid-word", () => {
  it("every phase a seat is printed in (ready, live, Not played) truncates each name; a waiting seat's words wrap", () => {
    const matches = [
      row("r", 4, "ready", sv("Ravi Menon"), sv(LONG), { next: true }),
      row("l", 5, "live", sv(LONG), sv("Ines Duarte"), { score: "0–0" }),
      row("w", 6, "waiting", { name: null, label: "Winner of match 4", winner: false }, sv(LONG)),
      row("n", 3, "notPlayed", sv("Oskar Lind"), sv(LONG)),
    ];
    const tree = expand(
      <QuickMatchList title="League matches" matches={matches} versus="v" waits="Waits" liveLabel="Live" notPlayedLabel="Not played" />,
    );
    const sides = byTestId(tree, "qm-match-sides");
    expect(sides).toHaveLength(4);
    let named = 0;
    for (const s of sides) {
      const spans = all(s.props.children, (el) => el.type === "span");
      for (const span of spans) {
        const text = textOf(span);
        if (text === "v") continue;
        if (text.startsWith("Winner of")) {
          expect(tokens(span), "a waiting seat's words wrap").not.toContain("truncate");
          continue;
        }
        expect(tokens(span), text).toEqual(expect.arrayContaining(SEAT));
        named++;
      }
    }
    expect(named, "named seats checked (4 rows, one waiting)").toBe(7);
  });

  it("a finished row is one sentence (“A beat B”): it wraps at its words and nothing in it truncates", () => {
    const done = row("s", 1, "settled", sv(LONG), sv("Oskar Lind"), { result: `${LONG} beat Oskar Lind`, score: "1–0" });
    const tree = expand(
      <QuickMatchList title="League matches" matches={[done]} versus="v" waits="Waits" liveLabel="Live" notPlayedLabel="Not played" />,
    );
    const [sides] = byTestId(tree, "qm-match-sides");
    expect(textOf(sides)).toBe(`${LONG} beat Oskar Lind`);
    expect(all(sides, (el) => tokens(el).includes("truncate"))).toHaveLength(0);
  });
});

// ── 3. the Full table's side column ──────────────────────────────────────────────────────────────────────────────────

describe("the Full table's side column: capped on a phone, the room the numbers leave from md", () => {
  it("a tagged row and a plain one: the 10rem cap holds below md and lifts from md, the cell takes the width, a 10rem floor", () => {
    const view: StandingsView = {
      title: "Standings", note: null, rankLabel: "Place", sideLabel: "Side", levelLabel: null,
      columns: [{ key: "p", abbr: "P", word: "Played" }],
      rows: [
        { entrantId: "a", place: "1", name: "Ines Duarte", cells: ["4"], leader: true },
        { entrantId: "b", place: "=", name: LONG, cells: ["4"], leader: false, toDecide: true, placeHidden: true, tag: { text: "level — to decide", kind: "toDecide" } },
      ],
      full: { label: "Full table", regionLabel: "Full table", columns: [{ key: "p", abbr: "P", word: "Played" }], cells: [["4"], ["4"]] },
    };
    const tree = expand(<QuickMatchFullTable view={view} full={view.full!} />);
    const heads = all(tree, (el) => el.type === "th" && el.props.scope === "row");
    expect(heads).toHaveLength(2);
    for (const th of heads) {
      const name = textOf(th).startsWith(LONG) ? LONG : "Ines Duarte";
      expect(tokens(th), name).toContain("md:w-full");
      const [floor] = all(th.props.children, (el) => tokens(el).includes("md:min-w-[10rem]"));
      expect(floor, `${name}: the floor box`).toBeDefined();
      const [fill] = all(floor!.props.children, (el) => tokens(el).includes("md:w-0"));
      expect(fill, `${name}: the box that adds nothing to the column`).toBeDefined();
      expect(tokens(fill!)).toContain("md:min-w-full");
      const [nameEl] = all(fill!.props.children, (el) => textOf(el) === name && tokens(el).includes("truncate"));
      expect(nameEl, name).toBeDefined();
      expect(tokens(nameEl!), `${name}: the phone cap stays`).toContain("max-w-[10rem]");
      expect(tokens(nameEl!), `${name}: lifted from md`).toContain("md:max-w-none");
    }
  });
});

// ── the arbitrary values compile to real CSS (an unknown utility compiles to nothing) ────────────────────────────────

describe("the new arbitrary utilities compile", () => {
  it("the fit, the container, the seat floor and the Full table's floor are real declarations", async () => {
    const css = await compileClasses([FIT, "@container", NAME_FLOOR, "md:min-w-[10rem]", "md:min-w-full", "md:w-0", "md:max-w-none"]);
    // Tailwind spaces the operators of an arbitrary value; the declaration is compared without whitespace.
    const bare = (cls: string, prop: string) => css.get(cls)?.[prop]?.replace(/\s+/g, "");
    expect(Object.keys(css.get(FIT) ?? {})).toEqual(["font-size"]);
    expect(bare(FIT, "font-size")).toBe("clamp(1.25rem,calc(100cqi/var(--qm-name-run)/0.55),2rem)");
    expect(css.get("@container")).toEqual({ "container-type": "inline-size" });
    expect(Object.keys(css.get(NAME_FLOOR) ?? {})).toEqual(["min-width"]);
    expect(bare(NAME_FLOOR, "min-width")).toBe("min(100%,5rem)");
    expect(css.get("md:min-w-[10rem]")).toEqual({ "min-width": "10rem" });
    expect(css.get("md:min-w-full")).toEqual({ "min-width": "100%" });
    expect(css.get("md:w-0")?.width).toBeDefined();
    expect(css.get("md:max-w-none")).toEqual({ "max-width": "none" });
  });
});
