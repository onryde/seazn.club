// Task 6 (R1 chassis): TileGrid pure functions.
//
// tilesForPhase is the mechanism that stops set-score entry being offered
// mid-game and stops post-match actions appearing while play is live
// (D-16) — a skin's tiles(view) declares `phases` per tile; this filters to
// the ones live right now.
//
// assertTileHierarchy is the mechanism that makes "monster-button
// monotony" (the defect the previous pad was rejected for — every action
// the same visual weight, so Abandon read like a rally tap) structurally
// impossible: no skin can declare more than two `primary` tiles for one
// phase (D-12). Framed PER PHASE, not globally, mirroring the brief
// exactly: two primaries in "live" and two more in "post" is a legal
// 4-primary skin; three in the SAME phase is not. Never throws — returns
// violation strings, same non-throwing convention as `assertScorebugSpec`
// in ../types.ts (see ../__tests__/types.test.ts).
import { describe, it, expect, vi, afterEach } from "vitest";
import { tilesForPhase, assertTileHierarchy, assertDisabledTilesExplained, TileGrid, type TileGridProps } from "../tile-grid";
import type { ContextStripSpec, TileSpec } from "../types";
import type { Dict } from "@/lib/i18n-constants";
import { t as realT } from "@/lib/i18n-runtime";
import type { MessageKey } from "@/lib/messages";

// `pad.tile.label`/`pad.tile.label.missing` are this file's own fixture
// namespace, resolved only against the local `dict` fixtures below via
// `realTStub` — never the real dictionary — so they are cast rather than
// spelled as genuine `ui.json` entries.
const K = (key: string): MessageKey => key as MessageKey;

const tile = (over: Partial<TileSpec> = {}): TileSpec => ({
  id: "t",
  label: K("pad.tile.label"),
  kind: "standard",
  phases: ["live"],
  action: { event: { type: "x", payload: {} } },
  ...over,
});

describe("tilesForPhase", () => {
  it("keeps only tiles whose phases include the requested phase", () => {
    const tiles = [tile({ id: "a", phases: ["live"] }), tile({ id: "b", phases: ["pre"] })];
    expect(tilesForPhase(tiles, "live").map((t) => t.id)).toEqual(["a"]);
  });

  it("keeps a multi-phase tile for every phase it declares", () => {
    const tiles = [tile({ id: "a", phases: ["live", "post"] })];
    expect(tilesForPhase(tiles, "live").map((t) => t.id)).toEqual(["a"]);
    expect(tilesForPhase(tiles, "post").map((t) => t.id)).toEqual(["a"]);
    expect(tilesForPhase(tiles, "pre").map((t) => t.id)).toEqual([]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(tilesForPhase([tile({ phases: ["pre"] })], "post")).toEqual([]);
  });
});

describe("assertTileHierarchy", () => {
  it("accepts exactly two primary tiles declared for one phase", () => {
    const tiles = [
      tile({ id: "a", kind: "primary", phases: ["live"] }),
      tile({ id: "b", kind: "primary", phases: ["live"] }),
      tile({ id: "c", kind: "standard", phases: ["live"] }),
    ];
    expect(assertTileHierarchy(tiles)).toEqual([]);
  });

  it("rejects three primary tiles declared for the same phase", () => {
    const tiles = [
      tile({ id: "a", kind: "primary", phases: ["live"] }),
      tile({ id: "b", kind: "primary", phases: ["live"] }),
      tile({ id: "c", kind: "primary", phases: ["live"] }),
    ];
    expect(assertTileHierarchy(tiles)).toEqual(['phase "live": 3 primary tiles declared (max 2)']);
  });

  it("does not aggregate primaries declared in DIFFERENT phases", () => {
    // Two primaries total, but one lives in "live" and the other in "post"
    // — neither phase individually exceeds two, so this is legal.
    const tiles = [
      tile({ id: "a", kind: "primary", phases: ["live"] }),
      tile({ id: "b", kind: "primary", phases: ["post"] }),
    ];
    expect(assertTileHierarchy(tiles)).toEqual([]);
  });

  it("treats each phase independently: 2 in live + 2 in post is legal, not a global 4", () => {
    const tiles = [
      tile({ id: "a", kind: "primary", phases: ["live"] }),
      tile({ id: "b", kind: "primary", phases: ["live"] }),
      tile({ id: "c", kind: "primary", phases: ["post"] }),
      tile({ id: "d", kind: "primary", phases: ["post"] }),
    ];
    expect(assertTileHierarchy(tiles)).toEqual([]);
  });

  it("counts a multi-phase primary tile toward EVERY phase it declares", () => {
    const tiles = [
      tile({ id: "a", kind: "primary", phases: ["live", "post"] }),
      tile({ id: "b", kind: "primary", phases: ["live", "post"] }),
      tile({ id: "c", kind: "primary", phases: ["live", "post"] }),
    ];
    const v = assertTileHierarchy(tiles);
    expect(v).toContain('phase "live": 3 primary tiles declared (max 2)');
    expect(v).toContain('phase "post": 3 primary tiles declared (max 2)');
    expect(v).toHaveLength(2);
  });

  it("ignores non-primary kinds entirely, however many are declared", () => {
    const tiles = [
      tile({ id: "a", kind: "standard", phases: ["live"] }),
      tile({ id: "b", kind: "destructive", phases: ["live"] }),
      tile({ id: "c", kind: "minor", phases: ["live"] }),
      tile({ id: "d", kind: "standard", phases: ["live"] }),
    ];
    expect(assertTileHierarchy(tiles)).toEqual([]);
  });
});

// R2b-cricket-over review fix (item 4): a skin can legally set
// `disabled: true` on a tile with NO `context()` at all, or a context()
// whose slots all omit `message` — the chassis then renders a real
// `<button disabled>` explaining nothing, and nothing (type, test, lint)
// catches the omission today. `assertDisabledTilesExplained` is the same
// kind of validator as `assertTileHierarchy` above — never a throw, a set
// of violation strings a skin's own test suite (or a later CI gate) can
// assert against — deliberately test-only, NOT wired into pad-host.tsx's
// render path: a disabled tile with no explanation is a cosmetic gap, not
// a correctness bug that should crash a live pad mid-match, same posture
// `assertTileHierarchy`/`assertScorebugSpec` already take for their own
// violations (see this file's own header, and ../types.ts's
// assertScorebugSpec).
//
// The doc's own ruling (TileSpec.disabled, ../types.ts) is that ONE cause
// can disable MANY tiles at once and the reason lives ONCE, on whichever
// ContextSlot names the person/fact at fault — never repeated per tile.
// So this validator is a SET-LEVEL check, not a per-tile pairing: "if any
// tile is disabled, at least one context slot must carry a non-empty
// message somewhere" — never "every disabled tile needs its OWN slot".
describe("assertDisabledTilesExplained", () => {
  const ctx = (slots: ContextStripSpec["slots"]): ContextStripSpec => ({ slots });

  it("no disabled tiles at all: no violations, regardless of context", () => {
    const tiles = [tile({ id: "a", disabled: false }), tile({ id: "b" })];
    expect(assertDisabledTilesExplained(tiles, null)).toEqual([]);
  });

  it("a disabled tile with context() entirely absent (null): one violation naming the tile", () => {
    const tiles = [tile({ id: "a", disabled: true })];
    expect(assertDisabledTilesExplained(tiles, null)).toEqual([
      'tile "a": disabled with no context slot message explaining why',
    ]);
  });

  it("a disabled tile with a context() whose every slot omits message: one violation", () => {
    const tiles = [tile({ id: "a", disabled: true })];
    const context = ctx([{ id: "bowler", label: "pad.context.bowler", pool: "onfield", required: true }]);
    expect(assertDisabledTilesExplained(tiles, context)).toEqual([
      'tile "a": disabled with no context slot message explaining why',
    ]);
  });

  it("a disabled tile paired with a slot message: no violation — the reason lives once, not per tile", () => {
    const tiles = [tile({ id: "a", disabled: true })];
    const context = ctx([
      { id: "bowler", label: "pad.context.bowler", pool: "onfield", required: true, message: "No bowler is eligible." },
    ]);
    expect(assertDisabledTilesExplained(tiles, context)).toEqual([]);
  });

  it("MULTIPLE disabled tiles, one shared message: zero violations — a single cause can disable many tiles at once", () => {
    const tiles = [
      tile({ id: "a", disabled: true }),
      tile({ id: "b", disabled: true }),
      tile({ id: "c" }), // not disabled — irrelevant either way
    ];
    const context = ctx([
      { id: "bowler", label: "pad.context.bowler", pool: "onfield", required: true, message: "No bowler is eligible." },
    ]);
    expect(assertDisabledTilesExplained(tiles, context)).toEqual([]);
  });

  it("MULTIPLE disabled tiles with no message anywhere: one violation PER disabled tile", () => {
    const tiles = [tile({ id: "a", disabled: true }), tile({ id: "b", disabled: true }), tile({ id: "c" })];
    expect(assertDisabledTilesExplained(tiles, null)).toEqual([
      'tile "a": disabled with no context slot message explaining why',
      'tile "b": disabled with no context slot message explaining why',
    ]);
  });

  it('a message: "" (empty string) slot does not count — same truthy rule item 3 fixed on the renderer side', () => {
    const tiles = [tile({ id: "a", disabled: true })];
    const context = ctx([{ id: "bowler", label: "pad.context.bowler", pool: "onfield", required: true, message: "" }]);
    expect(assertDisabledTilesExplained(tiles, context)).toEqual([
      'tile "a": disabled with no context slot message explaining why',
    ]);
  });
});

// Fix round 1, review finding 1 (Important): a grid item's default
// `min-width: auto` is content-based, so an unbreakable single-token i18n
// label in the last column can push the whole grid past a 320px viewport
// even though `grid-cols-4` resolves to `repeat(4, minmax(0,1fr))` —
// `minmax(0,1fr)` frees the TRACK's automatic minimum, not the ITEM's own
// content-based one. Fix: `min-w-0` on the tile button (the grid item) +
// `break-words` on the label/sublabel spans (so the text's own min-content
// size can shrink below its full unbroken width).
//
// The primary proof for this fix is EMPIRICAL, not this unit test: the
// real compiled Tailwind v4 CSS (via `@tailwindcss/postcss`, the same
// plugin apps/web's own build uses) rendered at a 320px viewport in
// headless Chromium, comparing `document.scrollWidth` against
// `clientWidth` before and after these two classes — see
// task-6-report.md's FIX ROUND 1 section for the exact numbers. That
// browser session was attempted from this environment but the shared
// Playwright MCP browser profile was locked by a concurrent session in
// this worktree at the time (confirmed via a harmless read-only
// `browser_tabs` "list" call, which failed identically to the navigate
// call — not something safe to force past by killing another agent's
// live browser). This describe block is the sanctioned fallback named in
// the review: a direct assertion that the fix's classes are present on
// the actual rendered output, reached by calling `TileGrid` as a plain
// function (React elements are plain objects; no jsdom needed) and
// invoking its child `Tile` element's own function to reach the real
// <button>/<span> props.
/** Minimal shape for reading rendered props back out — deliberately NOT
 *  React's own `ReactElement<P, T>` generics (its `.type` field's built-in
 *  type is `string | JSXElementConstructor<P>`, which has no call
 *  signature, so a real ReactElement type can't express "call `.type` as a
 *  function" without fighting the library's own types). This describes
 *  only the structural shape this test actually reads. */
interface RenderedEl<P> {
  type: (props: P) => RenderedEl<unknown> | { props: { className: string } };
  props: P;
}
interface SpanEl {
  props: { className: string };
}

describe("Tile rendering — finding 1 fix: min-w-0 / break-words present on the rendered output", () => {
  function renderTile(spec: TileSpec) {
    const grid = TileGrid({ tiles: [spec], phase: "live", t: (k) => k }) as unknown as RenderedEl<{
      children: RenderedEl<unknown>[];
    }>;
    const [tileEl] = grid.props.children;
    const button = tileEl.type(tileEl.props) as unknown as {
      props: { className: string; children: [SpanEl, SpanEl | false] };
    };
    return button;
  }

  it("the tile button carries min-w-0, so it can shrink below its content width as a grid item", () => {
    const button = renderTile(tile({ kind: "standard" }));
    expect(button.props.className).toContain("min-w-0");
  });

  it("the label span carries break-words, so an unbreakable token can wrap instead of forcing overflow", () => {
    const button = renderTile(tile({ kind: "standard" }));
    const [labelSpan] = button.props.children;
    expect(labelSpan.props.className).toContain("break-words");
  });

  it("the sublabel span also carries break-words when a sublabel is declared", () => {
    const button = renderTile(tile({ kind: "standard", sublabel: "pad.tile.sub" }));
    const [, sublabelSpan] = button.props.children;
    expect(sublabelSpan && sublabelSpan.props.className).toContain("break-words");
  });
});

// Review finding 1 (fix round, R2b): `TileSpec.sublabelText` — a
// PRE-LOCALISED raw string the chassis renders VERBATIM, never through
// `t()` (types.ts's own doc, same convention as `WhoLine.servingLabel`).
// Exists because cricket's over-summary tile carries a bare over NUMBER
// (locale-invariant, same category as `variantCode()`'s T20/ODI/HUNDRED/
// TEST) — the pre-fix code routed it through `sublabel` (an i18n KEY
// resolved via `t()`), which fired `[i18n] missing key: N` on every
// render because no dictionary will ever carry a key literally named "6".
//
// These tests call the REAL `t()` from lib/i18n-runtime.ts (not a stub),
// against a dict that resolves `label` cleanly but carries NO entry for
// either sublabel value used below — isolating the warn spy to the
// SUBLABEL path specifically, the one this fix changes. A stub `t` that
// merely echoed its key back (this file's other describe blocks use one)
// could not tell "warns" from "doesn't warn" at all.
describe("Tile rendering — sublabelText: pre-localised raw text, never routed through t() (review finding 1)", () => {
  // Belt-and-suspenders over the manual `warn.mockRestore()` at the end of
  // each `it` below: a RED assertion throws before reaching that line,
  // which would otherwise leave console.warn mocked (and that test's own
  // call count still attached) for whatever test runs next in this file.
  // Load-bearing while these tests are red pre-fix, not just tidiness.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const dict: Dict = { "pad.tile.label": "Label" };
  const realTStub: TileGridProps["t"] = (k, vars) => realT(dict, k, vars);

  function renderSublabel(spec: TileSpec) {
    const grid = TileGrid({ tiles: [spec], phase: "live", t: realTStub }) as unknown as RenderedEl<{
      children: RenderedEl<unknown>[];
    }>;
    const [tileEl] = grid.props.children;
    const button = tileEl.type(tileEl.props) as unknown as {
      props: { children: [unknown, { props: { children: string } } | false] };
    };
    return button.props.children[1];
  }

  it("sublabelText renders verbatim and fires no i18n missing-key warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const span = renderSublabel(tile({ sublabelText: "6" }));
    expect(span && span.props.children).toBe("6");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("mutation proof the spy is real: the OLD sublabel-as-key shape DOES fire the missing-key warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    renderSublabel(tile({ sublabel: "6" }));
    expect(warn).toHaveBeenCalledWith("[i18n] missing key: 6");
    warn.mockRestore();
  });

  it("when both sublabel and sublabelText are set, sublabelText wins verbatim and sublabel's key is never resolved (no warning)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const span = renderSublabel(tile({ sublabel: "pad.tile.sub", sublabelText: "6" }));
    expect(span && span.props.children).toBe("6");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("sublabel alone still resolves through t() exactly as before — no regression to the existing path", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const span = renderSublabel(tile({ sublabel: "pad.tile.label" })); // a KEY that DOES exist in `dict`
    expect(span && span.props.children).toBe("Label");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

// R2b (owner sign-off finding, single-line label fix): `TileSpec.labelText`
// — a PRE-LOCALISED raw string the chassis renders VERBATIM, never through
// `t()` (types.ts's own doc, same convention as `sublabelText` above and
// `WhoLine.servingLabel`/`ScorebugSpec.context` elsewhere in this file).
// Exists because cricket's over-summary tile needs a variable INSIDE its
// own label sentence ("End of over 2") — tile-grid.tsx's `t(tile.label)`
// call takes no `vars` argument, so a skin that needs one calls `t(key,
// vars)` itself and hands the chassis the already-resolved string.
//
// Same isolation trick the sublabelText block above uses: the dict below
// resolves `pad.tile.label` cleanly but has NO entry for the key used as
// the "label alone" fixture, so a stub `t` that merely echoed its key back
// could not tell "resolved through t()" from "rendered verbatim" apart —
// only the REAL t() (lib/i18n-runtime.ts), which warns on a missing key,
// can.
describe("Tile rendering — labelText: pre-localised raw text, never routed through t() (owner sign-off, single-line label fix)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const dict: Dict = { "pad.tile.label": "Label" };
  const realTStub: TileGridProps["t"] = (k, vars) => realT(dict, k, vars);

  function renderLabel(spec: TileSpec) {
    const grid = TileGrid({ tiles: [spec], phase: "live", t: realTStub }) as unknown as RenderedEl<{
      children: RenderedEl<unknown>[];
    }>;
    const [tileEl] = grid.props.children;
    const button = tileEl.type(tileEl.props) as unknown as {
      props: { children: [{ props: { children: string } }, unknown] };
    };
    return button.props.children[0];
  }

  it("labelText wins verbatim over label's key, and label's key is never resolved (no missing-key warning)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // "pad.tile.label.missing" has NO entry in `dict` — if the chassis ever
    // fell back to resolving `label` through t(), this would warn.
    const span = renderLabel(tile({ label: K("pad.tile.label.missing"), labelText: "End of over 2" }));
    expect(span.props.children).toBe("End of over 2");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("mutation proof the spy is real: label alone (no labelText) DOES fire the missing-key warning for an unresolved key", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    renderLabel(tile({ label: K("pad.tile.label.missing") }));
    expect(warn).toHaveBeenCalledWith("[i18n] missing key: pad.tile.label.missing");
    warn.mockRestore();
  });

  it("label alone still resolves through t() exactly as before — no regression to the existing path", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const span = renderLabel(tile({ label: K("pad.tile.label") })); // a KEY that DOES exist in `dict`
    expect(span.props.children).toBe("Label");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

// Task A1 (R2 wave): the guided-sheet renderer's own consumer-side wiring.
// R1 shipped TileSpec.action = {sheet: string} (types.ts) but this file
// forwarded EVERY action shape to onAction untouched — nothing routed a
// {sheet} tap anywhere distinct from a real event tap (_INDEX.md, R1 "owed
// by later waves"). A1 carves out a SEPARATE path (onOpenSheet) for
// {sheet} only; {event} and {swap:true} must stay byte-identical through
// onAction — a later task wires both hosts (the guided sheet itself, and
// swap-sheet's own host), so this file's only job is correct ROUTING, not
// deciding what either destination does with what it's handed.
describe("Tile action routing (task A1) — {sheet} takes a distinct path, {event}/{swap} stay byte-identical through onAction", () => {
  function clickTile(
    spec: TileSpec,
    handlers: { onAction?: TileGridProps["onAction"]; onOpenSheet?: TileGridProps["onOpenSheet"] },
  ): void {
    const grid = TileGrid({ tiles: [spec], phase: "live", t: (k) => k, ...handlers }) as unknown as RenderedEl<{
      children: RenderedEl<unknown>[];
    }>;
    const [tileEl] = grid.props.children;
    const button = tileEl.type(tileEl.props) as unknown as { props: { onClick: () => void } };
    button.props.onClick();
  }

  it("a {sheet} tile calls onOpenSheet with the sheet key and never calls onAction", () => {
    const opened: string[] = [];
    const actioned: unknown[] = [];
    clickTile(tile({ action: { sheet: "wicket" } }), {
      onOpenSheet: (key) => opened.push(key),
      onAction: (a) => actioned.push(a),
    });
    expect(opened).toEqual(["wicket"]);
    expect(actioned).toEqual([]);
  });

  it("an {event} tile still calls onAction(action, tile) untouched, and never calls onOpenSheet", () => {
    const actioned: unknown[] = [];
    const opened: string[] = [];
    const spec = tile({ id: "four", action: { event: { type: "cricket.ball", payload: { runs: 4 } } } });
    clickTile(spec, {
      onAction: (a, tapped) => actioned.push([a, tapped.id]),
      onOpenSheet: (key) => opened.push(key),
    });
    expect(actioned).toEqual([[spec.action, "four"]]);
    expect(opened).toEqual([]);
  });

  it("a {swap:true} tile still calls onAction(action, tile) untouched, and never calls onOpenSheet", () => {
    const actioned: unknown[] = [];
    const opened: string[] = [];
    const spec = tile({ id: "sub", action: { swap: "subHome" } });
    clickTile(spec, {
      onAction: (a, tapped) => actioned.push([a, tapped.id]),
      onOpenSheet: (key) => opened.push(key),
    });
    expect(actioned).toEqual([[spec.action, "sub"]]);
    expect(opened).toEqual([]);
  });

  it("a {sheet} tile with no onOpenSheet handler does not throw and does not silently fall back to onAction", () => {
    const actioned: unknown[] = [];
    expect(() =>
      clickTile(tile({ action: { sheet: "wicket" } }), { onAction: (a) => actioned.push(a) }),
    ).not.toThrow();
    expect(actioned).toEqual([]);
  });
});

// R2b (owner ruling, bowler-eligibility block, 2026-08-17): `TileSpec.
// disabled` — a tile that must stay VISIBLE (never removed — cricket's
// run/extra/wicket tiles while the resolved bowler is ineligible) but must
// not accept a tap. Rendered as a real, native `disabled` <button> (never a
// control that merely LOOKS disabled, same posture ContextSlot.readOnly's
// own doc takes one file over) plus a stable `data-tile-disabled` hook a
// Playwright spec can assert on without relying on visual styling alone.
describe("Tile rendering — disabled (R2b bowler-eligibility block)", () => {
  function renderTile(spec: TileSpec, handlers: { onAction?: TileGridProps["onAction"]; onOpenSheet?: TileGridProps["onOpenSheet"] } = {}) {
    const grid = TileGrid({ tiles: [spec], phase: "live", t: (k) => k, ...handlers }) as unknown as RenderedEl<{
      children: RenderedEl<unknown>[];
    }>;
    const [tileEl] = grid.props.children;
    return tileEl.type(tileEl.props) as unknown as {
      props: { disabled: boolean; onClick: () => void; className: string } & Record<string, unknown>;
    };
  }

  it("a disabled tile's button carries the native disabled attribute and data-tile-disabled=\"true\"", () => {
    const button = renderTile(tile({ disabled: true }));
    expect(button.props.disabled).toBe(true);
    expect(button.props["data-tile-disabled"]).toBe("true");
  });

  it("an ordinary tile (disabled absent) is NOT native-disabled and carries data-tile-disabled=\"false\"", () => {
    const button = renderTile(tile());
    expect(button.props.disabled).toBe(false);
    expect(button.props["data-tile-disabled"]).toBe("false");
  });

  it("a disabled {event} tile's tap does not call onAction", () => {
    const actioned: unknown[] = [];
    const button = renderTile(tile({ disabled: true, action: { event: { type: "cricket.ball", payload: {} } } }), {
      onAction: (a) => actioned.push(a),
    });
    button.props.onClick();
    expect(actioned).toEqual([]);
  });

  it("a disabled {sheet} tile's tap does not call onOpenSheet either", () => {
    const opened: string[] = [];
    const button = renderTile(tile({ disabled: true, action: { sheet: "wicket" } }), {
      onOpenSheet: (key) => opened.push(key),
    });
    button.props.onClick();
    expect(opened).toEqual([]);
  });

  it("mutation proof: an ENABLED tile with the identical action DOES call onAction — isolates the assertion to the disabled flag, not a broken handler", () => {
    const actioned: unknown[] = [];
    const button = renderTile(tile({ action: { event: { type: "cricket.ball", payload: {} } } }), {
      onAction: (a) => actioned.push(a),
    });
    button.props.onClick();
    expect(actioned).toHaveLength(1);
  });

  it("a disabled tile still carries its usual className (visible, same kind styling) plus a disabled treatment — never removed from the grid", () => {
    const button = renderTile(tile({ disabled: true, kind: "primary" }));
    expect(button.props.className).toContain("bg-violet-600"); // primary kind styling still present
    expect(button.props.className).toContain("disabled:opacity-40");
  });
});
