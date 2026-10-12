// T14 — the room controls in the owner-approved canvas states (2026-10-11):
// before both have moved — disabled "Draw after move 1" + "Abort game" (abort
// lasts until ply 2, as in lila); mid-game — "Offer draw" + "Resign"; an
// incoming offer — option A's card (Decline / Accept draw) above Resign; your
// own offer — a disabled "Draw offered" + Resign + who you are waiting for.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { RoomControls, RoomControlsView } from "../controls";
import type { RoomActBody } from "../room-api";

// Vars rendered as key(name=value,…): no quotes, so React's text escaping
// cannot hide them.
const t = (key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}(${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(",")})` : key;
const base = {
  ply: 4,
  over: false,
  you: "white" as const,
  drawOfferBy: null as "white" | "black" | null,
  opponentName: "Ada Okonkwo",
  busy: false,
  onAct: () => {},
  t,
};
const has = (html: string, id: string) => html.includes(`data-testid="${id}"`);
/** lila, not our code: a game is `abortable` while fewer than two plies are
 *  played (chess/Game.scala `abortable`), and draw offers wait for the same
 *  floor — the reconcile suite pins the same value (LILA_DRAW_MIN_PLY). */
const DRAW_MIN_PLY = 2;

describe("RoomControls", () => {
  it("mid-game: Offer draw and Resign, and NO abort", () => {
    const html = renderToStaticMarkup(<RoomControls {...base} />);
    expect(has(html, "room-draw") && has(html, "room-resign")).toBe(true);
    expect(has(html, "room-abort")).toBe(false);
    expect(html).toContain("externalPlay.room.offerDraw");
  });

  it("every ply below the draw floor shows Abort and a disabled draw, and no Resign; the floor itself flips both", () => {
    let checked = 0;
    for (let ply = 0; ply <= DRAW_MIN_PLY; ply += 1) {
      const html = renderToStaticMarkup(<RoomControls {...base} ply={ply} />);
      const early = ply < DRAW_MIN_PLY;
      expect(has(html, "room-abort"), `ply ${ply}`).toBe(early);
      expect(has(html, "room-resign"), `ply ${ply}`).toBe(!early);
      expect(/data-testid="room-draw"[^>]*\sdisabled=""/.test(html), `ply ${ply}`).toBe(early);
      expect(html.includes("externalPlay.room.drawAfterMoveOne"), `ply ${ply}`).toBe(early);
      checked += 1;
    }
    expect(checked, "anti-vacuity: plies 0..DRAW_MIN_PLY").toBe(DRAW_MIN_PLY + 1);
  });

  it("an incoming offer: the draw card with Decline and Accept draw, Resign stays, no Offer draw", () => {
    const html = renderToStaticMarkup(<RoomControls {...base} drawOfferBy="black" />);
    expect(has(html, "room-draw-offer")).toBe(true);
    expect(has(html, "room-draw-accept") && has(html, "room-draw-decline") && has(html, "room-resign")).toBe(true);
    expect(has(html, "room-draw")).toBe(false);
    expect(html).toContain('externalPlay.room.drawOfferIncoming(name=Ada)');
    expect(html).toContain("externalPlay.room.drawOfferHint");
  });

  it("your own offer: a disabled Draw offered (never Accept/Decline), Resign, and who you wait for", () => {
    const html = renderToStaticMarkup(<RoomControls {...base} drawOfferBy="white" />);
    expect(/data-testid="room-draw-offered"[^>]*\sdisabled=""/.test(html)).toBe(true);
    expect(has(html, "room-draw-accept") || has(html, "room-draw-decline")).toBe(false);
    expect(has(html, "room-resign")).toBe(true);
    expect(html).toContain('externalPlay.room.waitingForAnswer(name=Ada)');
  });

  it("a game that is over renders no action at all", () => {
    let checked = 0;
    for (const drawOfferBy of [null, "white", "black"] as const) {
      for (const ply of [0, 1, 2, 40]) {
        expect(renderToStaticMarkup(<RoomControls {...base} over ply={ply} drawOfferBy={drawOfferBy} />)).toBe("");
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: over × offer × ply").toBe(12);
  });

  it("busy disables every action button", () => {
    let checked = 0;
    for (const props of [{ ply: 0 }, { ply: 4 }, { ply: 4, drawOfferBy: "black" as const }]) {
      const html = renderToStaticMarkup(<RoomControls {...base} {...props} busy />);
      const buttons = [...html.matchAll(/<button[^>]*>/g)].map((m) => m[0]);
      expect(buttons.length, JSON.stringify(props)).toBeGreaterThan(0);
      for (const b of buttons) expect(b, JSON.stringify(props)).toMatch(/\sdisabled=""/);
      checked += buttons.length;
    }
    expect(checked, "anti-vacuity: buttons checked").toBeGreaterThan(3);
  });

  it("every action button meets the 44px tap floor", () => {
    const html = renderToStaticMarkup(<RoomControls {...base} drawOfferBy="black" />);
    const buttons = [...html.matchAll(/<button[^>]*>/g)].map((m) => m[0]);
    expect(buttons.length).toBeGreaterThan(2);
    for (const b of buttons) expect(b).toMatch(/min-h-11/);
  });

  it("no file in the match room offers a takeback (spec §6 — a dispute magnet with a camera on it)", () => {
    const dir = join(__dirname, "..");
    const files = readdirSync(dir).filter((f) => /\.(ts|tsx)$/.test(f));
    expect(files.length, "anti-vacuity: match-room files scanned").toBeGreaterThan(5);
    for (const f of files) {
      const src = readFileSync(join(dir, f), "utf8").toLowerCase();
      expect(src, f).not.toContain("takeback");
      expect(src, f).not.toContain("take-back");
    }
  });
});

// Pressing buttons without a DOM: walk the view's element tree (it has no
// hooks) and call the button's onClick. The ConfirmDialog is a component, so
// its confirm is reached through its own onConfirm prop.
function walk(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  out.push(node);
  walk((node.props as { children?: ReactNode }).children, out);
  return out;
}
const byTestId = (els: ReactElement[], id: string) =>
  els.find((e) => (e.props as { "data-testid"?: string })["data-testid"] === id);

function press(id: string, props: Partial<typeof base> & { confirm?: null | "resign" | "abort" } = {}) {
  const acts: RoomActBody[] = [];
  const confirms: (null | "resign" | "abort")[] = [];
  const tree = RoomControlsView({
    ...base,
    ...props,
    onAct: (a) => acts.push(a),
    confirm: props.confirm ?? null,
    setConfirm: (c) => confirms.push(c),
  });
  const els = walk(tree);
  const target = byTestId(els, id);
  if (!target) throw new Error(`no ${id} rendered`);
  (target.props as { onClick: () => void }).onClick();
  return { acts, confirms, els };
}

describe("RoomControls — what each button SENDS (T10's PlayAction shapes)", () => {
  it("Offer draw sends draw/accept:true; Decline sends accept:false; Accept sends accept:true", () => {
    expect(press("room-draw").acts).toEqual([{ kind: "draw", accept: true }]);
    expect(press("room-draw-decline", { drawOfferBy: "black" }).acts).toEqual([{ kind: "draw", accept: false }]);
    expect(press("room-draw-accept", { drawOfferBy: "black" }).acts).toEqual([{ kind: "draw", accept: true }]);
  });

  it("Resign and Abort send NOTHING on the first press — they open the confirm", () => {
    const r = press("room-resign");
    expect([r.acts, r.confirms]).toEqual([[], ["resign"]]);
    const a = press("room-abort", { ply: 0 });
    expect([a.acts, a.confirms]).toEqual([[], ["abort"]]);
  });

  it("the confirm sends exactly the action it was opened for; Cancel sends nothing", () => {
    let checked = 0;
    for (const [kind, ply] of [["resign", 4], ["abort", 1]] as const) {
      const acts: RoomActBody[] = [];
      const confirms: (null | "resign" | "abort")[] = [];
      const els = walk(
        RoomControlsView({ ...base, ply, onAct: (a) => acts.push(a), confirm: kind, setConfirm: (c) => confirms.push(c) }),
      );
      const dialog = els.find((e) => (e.props as { testId?: string }).testId === `room-${kind}-confirm`);
      expect(dialog, kind).toBeDefined();
      (dialog!.props as { onCancel: () => void }).onCancel();
      expect(acts, `${kind} cancel`).toEqual([]);
      (dialog!.props as { onConfirm: () => void }).onConfirm();
      expect(acts, `${kind} confirm`).toEqual([{ kind }]);
      expect(confirms).toEqual([null, null]);
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("every word of the confirm resolves in all four locales — title, body, both buttons (a missing key paints raw)", () => {
    // T14 e2e review: the confirm button read a key no dictionary had, and
    // TKey accepts any string, so neither tsc nor a markup test saw it.
    const dicts = Object.fromEntries(
      ["en", "es", "fr", "nl"].map((l) => [
        l,
        JSON.parse(readFileSync(join(__dirname, `../../../../dictionaries/${l}/ui.json`), "utf8")) as Record<string, string>,
      ]),
    );
    let checked = 0;
    for (const [locale, dict] of Object.entries(dicts)) {
      const missing: string[] = [];
      const real = (key: string) => {
        if (dict[key] === undefined) missing.push(key);
        return dict[key] ?? key;
      };
      for (const [kind, ply] of [["resign", 4], ["abort", 1]] as const) {
        const els = walk(RoomControlsView({ ...base, ply, t: real, confirm: kind, setConfirm: () => {} }));
        const dialog = els.find((e) => (e.props as { testId?: string }).testId === `room-${kind}-confirm`)!;
        const p = dialog.props as { title: string; confirmLabel: string; cancelLabel: string; children: string };
        for (const text of [p.title, p.confirmLabel, p.cancelLabel, p.children]) {
          expect(text, `${locale} ${kind}`).not.toMatch(/^externalPlay\./);
          checked += 1;
        }
      }
      expect(missing, `${locale}: keys with no copy`).toEqual([]);
    }
    expect(checked, "anti-vacuity: 4 locales × 2 confirms × 4 texts").toBe(32);
  });

  it("a pressed disabled control is unreachable: Draw after move 1 and Draw offered carry no onClick", () => {
    const early = walk(RoomControlsView({ ...base, ply: 0, confirm: null, setConfirm: () => {} }));
    expect((byTestId(early, "room-draw")!.props as { onClick?: unknown }).onClick).toBeUndefined();
    const mine = walk(RoomControlsView({ ...base, drawOfferBy: "white", confirm: null, setConfirm: () => {} }));
    expect((byTestId(mine, "room-draw-offered")!.props as { onClick?: unknown }).onClick).toBeUndefined();
  });
});
