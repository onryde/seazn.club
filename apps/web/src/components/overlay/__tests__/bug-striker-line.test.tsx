// R2005 change 12 — the cricket corner bug carries the STRIKER, alone, as one line: `▸ <name> <runs> (<balls>)`.
//
// #974 (review a) dropped the crease from the bug because its 512 px footer, at the 30 px floor, could not hold a
// PAIR's figures beside the chase ("Haruto Fuj… · J…", every figure gone). One batter's figures are ~6 characters; the
// pair's were ~14 plus the joint. So the bug shows the one batter a viewer is watching, with the name yielding first.
//
// The lines come from the REAL `cricketDetail` over a ledger folded by the REAL engine (the striker is whoever the
// engine says is on strike), and the registry sweep builds every overlay sport's model from the gallery's own folded
// snapshots — never a typed fixture of what a crease looks like. The layout half (the name ellipses, the figures stay
// whole inside the tile at 1920 / 844 / 390) is `e2e/overlay-gallery.spec.ts` checks 8 and 8b.
import { describe, expect, it } from "vitest";
import { cricket, deriveCricketScorecard } from "@seazn/engine/sports/cricket";
import { defaultLineupPair, makeEnvelope, SIM_CONFIGS } from "@seazn/engine/testkit";
import { propsOf, textOf, walk } from "@/components/__tests__/_hook-harness";
import { cricketDetail, liveFromScorecard } from "@/lib/overlay-cricket";
import { nameLadder, overlayModel, type OverlayModel, type OverlayMsg } from "@/lib/overlay-model";
import { decidedOutcomeTemplates } from "@/lib/scoring-vocab";
import { GALLERY_SIDES, gallerySnapshots } from "@/server/overlay/gallery-snapshots";
import { OVERLAY_SPORT_KEYS } from "../overlay-tokens";
import { OverlayBug } from "../overlay-bug";
import type { ReactElement } from "react";

const MARK = "▸";
const msg: OverlayMsg = (key) => (key === "overlay.cricket.strikerMark" ? MARK : key);

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
/** A single (H-p1 → the other end), then a four by H-p2: H-p2 is ON STRIKE, H-p1 is not. */
const LEDGER = [
  makeEnvelope(1, { type: "cricket.toss", payload: { wonBy: "H", elected: "bat" } } as never),
  makeEnvelope(2, { type: "core.start", payload: {} } as never),
  makeEnvelope(3, { type: "cricket.ball", payload: { ...base, runs: { bat: 1 } } } as never),
  makeEnvelope(4, {
    type: "cricket.ball",
    payload: { ...base, ballInOver: 2, striker: "H-p2", nonStriker: "H-p1", runs: { bat: 4 }, boundary: 4 },
  } as never),
];
const scorecard = deriveCricketScorecard({ events: LEDGER as never, cfg: cfg as never, lineups });
const live = liveFromScorecard(scorecard, (id) => NAMES[id]);
const lines = cricketDetail(live, msg);
const striker = live!.batters.find((b) => b.onStrike)!;
const other = live!.batters.find((b) => !b.onStrike)!;

const MODEL: OverlayModel = {
  live: true,
  decided: false,
  voided: false,
  header: { context: "overlay.header.live", period: "" },
  sides: [
    { short: "ASH", name: "Ashgrove Rovers", ladder: nameLadder({ id: "h", name: "Ashgrove Rovers" }, "ASH"), big: "5/0", led: true, serving: false },
    { short: "NOR", name: "Northbridge Athletic", ladder: nameLadder({ id: "a", name: "Northbridge Athletic" }, "NOR"), big: "", led: false, serving: false },
  ],
  cellsKind: "none",
  cells: [],
  detail: lines,
};

const render = (model: OverlayModel) => walk(OverlayBug({ model, tick: [false, false], msg }));
const cls = (el: ReactElement) => (propsOf(el).className as string | undefined) ?? "";
const ofClass = (tree: ReactElement[], c: string) => tree.filter((el) => cls(el).split(" ").includes(c));
const footerOf = (tree: ReactElement[]) => tree.find((el) => propsOf(el)["data-testid"] === "ovl-detail");

describe("the bug's striker line (change 12)", () => {
  it("the fixture is what it claims: the engine put a different batter on strike from the other, both named", () => {
    expect(striker.name).toBe("Kohli");
    expect(other.name).toBe("Venkataraman Subramanian");
    expect([striker.runs, striker.balls]).toEqual([4, 1]);
  });

  it("cricket live: the chase leads, then ONE entry — the striker, mark, name and figures — and nobody else", () => {
    const tree = render({ ...MODEL, chase: "Need 45 off 30" });
    expect(textOf(tree.find((el) => propsOf(el)["data-testid"] === "ovl-chase")!)).toBe("Need 45 off 30");
    const entries = ofClass(tree, "ovl-detail-entry");
    expect(entries, "one entry").toHaveLength(1);
    expect(ofClass(tree, "ovl-detail-person"), "one person").toHaveLength(1);
    expect(ofClass(tree, "ovl-detail-name").map((n) => textOf(n))).toEqual([striker.name]);
    expect(ofClass(tree, "ovl-detail-figures").map((n) => textOf(n))).toEqual([`${striker.runs} (${striker.balls})`]);
    const text = textOf(footerOf(tree)!);
    expect(text, "the non-striker is not on the bug").not.toContain(other.name);
    expect(text, "nor the bowler").not.toContain(NAMES["A-p11"]);
    expect(ofClass(tree, "ovl-ball-glyph"), "nor this over's glyphs").toEqual([]);
    expect(cls(entries[0]!), "a figures entry keeps its content minimum").toContain("ovl-detail-entry--figures");
  });

  it("the mark LEADS the name, inside the name's own box (check 8's third half, M23)", () => {
    const tree = render(MODEL);
    const who = ofClass(tree, "ovl-detail-who");
    expect(who).toHaveLength(1);
    const inside = walk(propsOf(who[0]!).children as never);
    const order = inside.map(cls).filter((c) => c === "ovl-detail-mark" || c === "ovl-detail-name");
    expect(order).toEqual(["ovl-detail-mark", "ovl-detail-name"]);
    expect(textOf(ofClass(tree, "ovl-detail-mark")[0]!)).toBe(MARK);
  });

  it("no striker (nobody carries the mark): no line — and with nothing else to say, no footer at all", () => {
    const unmarked = lines.map((l) => (l.people ? { ...l, people: l.people.map((p) => ({ name: p.name, figures: p.figures })) } : l));
    const tree = render({ ...MODEL, detail: unmarked });
    expect(ofClass(tree, "ovl-detail-entry")).toEqual([]);
    expect(footerOf(tree), "never an empty band").toBeUndefined();
    expect(footerOf(render({ ...MODEL, detail: [] }))).toBeUndefined();
  });

  it("the cap stays two: the striker, then only the MOST RECENT non-crease line", () => {
    const tree = render({ ...MODEL, detail: [...lines, { text: "Older note" }, { text: "Rain delay 14:05" }] });
    const entries = ofClass(tree, "ovl-detail-entry");
    expect(entries).toHaveLength(2);
    expect(textOf(entries[0]!)).toContain(striker.name);
    expect(textOf(entries[1]!)).toContain("Rain delay 14:05");
    expect(textOf(footerOf(tree)!)).not.toContain("Older note");
  });

  it("without a crease (every other sport's detail): the two most recent lines, exactly as before", () => {
    const tree = render({ ...MODEL, detail: [{ text: "11v8" }, { text: "AWA Yellow" }, { text: "AWA Red card", tone: "dismissal" }] });
    expect(ofClass(tree, "ovl-detail-entry").map((e) => textOf(e))).toEqual(["AWA Yellow", "· AWA Red card"]);
  });
});

describe("registry sweep: no other sport's bug gains a crease line; cricket's live bug gains exactly the striker", () => {
  it("every overlay sport × warming / live / ended, from the gallery's folded snapshots", () => {
    const snaps = gallerySnapshots(1_700_000_000_000);
    let sports = 0;
    let cells = 0;
    let cricketLivePeople = -1;
    for (const sportKey of OVERLAY_SPORT_KEYS) {
      sports++;
      for (const kind of ["warming", "live", "ended"] as const) {
        const model = overlayModel({
          sportKey,
          data: snaps[sportKey]![kind],
          sides: [GALLERY_SIDES[0], GALLERY_SIDES[1]],
          startLabel: null,
          clockLabel: null,
          msg,
          decidedTemplates: decidedOutcomeTemplates((k) => k),
        });
        const people = ofClass(render(model), "ovl-detail-person").length;
        if (sportKey === "cricket" && kind === "live") cricketLivePeople = people;
        else expect(people, `${sportKey} × ${kind}`).toBe(0);
        cells++;
      }
    }
    console.log(`bug sports checked: ${sports} (cells: ${cells})`);
    expect(sports).toBe(OVERLAY_SPORT_KEYS.length);
    expect(sports).toBeGreaterThan(1);
    expect(cricketLivePeople, "cricket's live bug: the striker, one person").toBe(1);
  });
});
