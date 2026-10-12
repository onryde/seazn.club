// T14 — option B's promotion sheet, as markup facts (its taps are the e2e's).
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PromotionPicker } from "../promotion-picker";

const t = (key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}(${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(",")})` : key;

describe("PromotionPicker", () => {
  const html = renderToStaticMarkup(<PromotionPicker square="d8" colour="white" onPick={() => {}} onCancel={() => {}} t={t} />);

  it("is a dialog titled with the square, offering Queen, Rook, Bishop, Knight in that order, then Cancel", () => {
    expect(html).toContain('role="dialog"');
    expect(html).toContain("externalPlay.room.promote.title(square=d8)");
    const order = [...html.matchAll(/data-testid="room-promote-([a-z]+)"/g)].map((m) => m[1]);
    expect(order).toEqual(["q", "r", "b", "n", "cancel"]);
  });

  it("Queen carries the pre-selected style; each choice is a 72px target with the player's own colour", () => {
    expect(html).toMatch(/data-testid="room-promote-q"[^>]*border-2 border-\[#7c3aed\]/);
    expect(html).not.toMatch(/data-testid="room-promote-r"[^>]*border-2/);
    expect([...html.matchAll(/min-h-\[72px\]/g)].length).toBe(4);
    expect([...html.matchAll(/<piece class="(queen|rook|bishop|knight) white">/g)].length).toBe(4);
    const black = renderToStaticMarkup(<PromotionPicker square="e1" colour="black" onPick={() => {}} onCancel={() => {}} t={t} />);
    expect([...black.matchAll(/<piece class="(queen|rook|bishop|knight) black">/g)].length).toBe(4);
  });
});
