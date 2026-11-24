// Owner 2026-11-24: the Seazn destination's mark is house lime ("green lime") with a night letter. What is held, and why each is a real
// failure: the tile aliases Tailwind's `--color-lime-400` (globals.css: under Tailwind v4 it is NOT `--mk-lime`, and a mark written with
// `--mk-lime` would be a different green from every other lime on the page); the letter is the night token; the letter reads on the tile at
// WCAG AA (4.5:1) - computed from the tokens' own values, the lime from the fallback written beside the alias (which the sport block of
// globals.css also uses), the night from `--mk-night` in globals.css, never a number typed here; and the tile is still `data-platform-mark=seazn`.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PlatformMark, STREAM_MARK_KINDS } from "../stream-platform-mark";

const css = readFileSync(new URL("../../../app/globals.css", import.meta.url), "utf8");
const lum = (hex: string): number => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
};
const ratio = (a: string, b: string): number => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};
const markOf = (kind: Parameters<typeof PlatformMark>[0]["kind"]) => renderToStaticMarkup(<PlatformMark kind={kind} size="md" />);

describe("the Seazn destination mark is lime", () => {
  it("aliases --color-lime-400 for the tile and the night token for the letter, never --mk-lime and never the old slate", () => {
    const html = markOf("seazn");
    expect(html).toContain('data-platform-mark="seazn"');
    expect(html).toMatch(/background:var\(--color-lime-400(, ?#[0-9a-f]{6})?\)/i);
    expect(html).toContain("color:var(--color-night)");
    expect(html).not.toContain("--mk-lime");
    expect(html).not.toContain("#0f172a");
    expect(html).toContain(">S<");
  });

  it("the letter reads on the tile at 4.5:1 or better (night from globals.css, lime from the alias's own fallback)", () => {
    const night = /--mk-night:\s*(#[0-9a-fA-F]{6})/.exec(css)?.[1];
    const lime = /var\(--color-lime-400, (#[0-9a-fA-F]{6})\)/.exec(markOf("seazn"))?.[1];
    expect(night, "--mk-night is a hex in globals.css").toBeDefined();
    expect(lime, "the tile's alias carries its sRGB fallback").toBeDefined();
    expect(ratio(night!, lime!)).toBeGreaterThanOrEqual(4.5);
    // The fallback is the same lime the sport block aliases (globals.css), so the two cannot drift apart.
    expect(css).toContain(`var(--color-lime-400, ${lime})`);
  });

  it("no other kind changed: every kind still has a mark, and Kick keeps its own green tile", () => {
    expect(STREAM_MARK_KINDS.length, "kinds checked").toBe(6);
    for (const k of STREAM_MARK_KINDS) expect(markOf(k), k).toContain(`data-platform-mark="${k}"`);
    expect(markOf("kick")).toContain("#53fc18");
    expect(markOf("kick")).not.toContain("--color-lime-400");
  });
});
