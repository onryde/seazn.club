// Cricket live focus: bar/bug show one batting hero + optional compact strip
// (closed score · Target N). Decided / dual-side layout is unchanged.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { OverlayModel, OverlayMsg } from "@/lib/overlay-model";
import { OverlayBar } from "../overlay-bar";
import { OverlayBug } from "../overlay-bug";

const msg: OverlayMsg = (key, vars) =>
  vars ? `${key}(${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(",")})` : key;

const side = (partial: Partial<OverlayModel["sides"][0]> & Pick<OverlayModel["sides"][0], "short" | "name" | "big">): OverlayModel["sides"][0] => ({
  ladder: [partial.name, partial.short],
  led: false,
  serving: false,
  ...partial,
});

const base = (focus?: OverlayModel["focus"]): OverlayModel => ({
  live: true,
  decided: false,
  voided: false,
  header: { context: "Live" },
  sides: [
    side({ short: "SBB", name: "Southend Blue Blazers", big: "48/3", sub: "(5.1)", led: false }),
    side({ short: "TBT", name: "Thorpe Bay Tigers", big: "32/2", sub: "(5)", led: true }),
  ],
  cellsKind: "none",
  cells: [],
  detail: [],
  chase: "Need 17 off 90",
  ...(focus === undefined ? {} : { focus }),
});

describe("cricket innings focus — bar & bug", () => {
  it("chase: strip + batting hero only on both themes", () => {
    const model = base({ hero: 1, strip: "SBB 48/3 · Target 49" });
    for (const html of [
      renderToStaticMarkup(<OverlayBar model={model} tick={[false, false]} msg={msg} />),
      renderToStaticMarkup(<OverlayBug model={model} tick={[false, false]} msg={msg} />),
    ]) {
      expect(html).toContain('data-testid="ovl-innings-strip"');
      expect(html).toContain("SBB 48/3 · Target 49");
      expect(html).toContain('data-testid="ovl-side-away"');
      expect(html).not.toContain('data-testid="ovl-side-home"');
      expect(html).toContain("32/2");
      expect(html).not.toContain("(5.1)"); // closed overs stay off the strip/hero
    }
  });

  it("1st innings: hero only, no strip", () => {
    const model = base({ hero: 0 });
    model.sides[0] = side({ short: "SBB", name: "Southend Blue Blazers", big: "40/1", sub: "(5)", led: true });
    model.sides[1] = side({ short: "TBT", name: "Thorpe Bay Tigers", big: "—", led: false });
    model.chase = undefined;
    const bar = renderToStaticMarkup(<OverlayBar model={model} tick={[false, false]} msg={msg} />);
    expect(bar).not.toContain('data-testid="ovl-innings-strip"');
    expect(bar).toContain('data-testid="ovl-side-home"');
    expect(bar).not.toContain('data-testid="ovl-side-away"');
  });

  it("no focus: both sides still render (decided / non-cricket)", () => {
    const model = base(undefined);
    const bar = renderToStaticMarkup(<OverlayBar model={model} tick={[false, false]} msg={msg} />);
    expect(bar).toContain('data-testid="ovl-side-home"');
    expect(bar).toContain('data-testid="ovl-side-away"');
    expect(bar).not.toContain('data-testid="ovl-innings-strip"');
  });
});
