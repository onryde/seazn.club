// The shared slim switch (#1187 extracted it; archive Task 5 owed its own test). Sport-agnostic: no sport sweep.
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { slimSwitch } from "@/components/sponsors/slim-switch";

const TAP_FLOOR_PX = 44;
const px = (cls: string, axis: "h" | "w"): number => Number(new RegExp(`(?:^|\\s)${axis}-(\\d+(?:\\.\\d+)?)(?:\\s|$)`).exec(cls)![1]) * 4;
const tag = (html: string, id: string) => new RegExp(`<[^>]*data-testid="${id}"[^>]*>`).exec(html)![0];
const cls = (t: string) => /class="([^"]*)"/.exec(t)![1]!;

describe("slimSwitch", () => {
  const draw = (over: Partial<Parameters<typeof slimSwitch>[0]> = {}): ReactElement =>
    slimSwitch({ checked: false, onToggle: () => {}, labelledBy: "lbl", testId: "sw", ...over });

  it("is a switch: role, aria-checked both ways, named by labelledBy, derived test ids", () => {
    for (const checked of [true, false]) {
      const html = renderToStaticMarkup(draw({ checked }));
      const t = tag(html, "sw");
      expect(t).toContain('role="switch"');
      expect(t).toContain(`aria-checked="${checked}"`);
      expect(t).toContain('aria-labelledby="lbl"');
      expect(html).toContain('data-testid="sw-track"');
      expect(html).toContain('data-testid="sw-knob"');
    }
  });

  it("disabled disables, enabled does not; onToggle is the click", () => {
    expect(tag(renderToStaticMarkup(draw({ disabled: true })), "sw")).toMatch(/\sdisabled=""/);
    expect(tag(renderToStaticMarkup(draw()), "sw")).not.toMatch(/\sdisabled=""/);
    const fn = vi.fn();
    (draw({ onToggle: fn }).props as { onClick: () => void }).onClick();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("is slim: a 44px target, a track no taller than 32px and at least 1.5x wider than tall", () => {
    const html = renderToStaticMarkup(draw());
    const btn = cls(tag(html, "sw"));
    expect(px(btn, "h")).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
    expect(px(btn, "w")).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
    const track = cls(tag(html, "sw-track"));
    expect(px(track, "h")).toBeLessThanOrEqual(32);
    expect(px(track, "w") / px(track, "h")).toBeGreaterThanOrEqual(1.5);
  });
});
