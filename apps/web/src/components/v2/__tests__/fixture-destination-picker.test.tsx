// The fixture stream panel's destination picker (YouTube Connect T12, owner's Option B, 2026-10-27).
//
// `apps/web` vitest is `environment: "node"` — no DOM. So three layers, each proven where it CAN be (AGENTS.md classes 1 and 2):
//   * `destinationRow` — the pure reading of one destination (its name, its kind line, its health badge), swept over every stored
//     kind, every privacy and the whole health matrix;
//   * the island DRIVEN (`renderIsland`, the repo's hook harness, with its hookless children expanded) — open, pick, the keyboard,
//     an outside press, the panel's "Use another destination" signal;
//   * the markup of what a customer reads in the open list.
// What none of this can see — the in-flow list at 320 px, the 56 px rows, the badge wrapping, real focus — is the shots spec
// (`e2e/youtube-panel.shots.spec.ts`).
//
// Expected values are typed from the spec / the owner's mock (§6.9 status names, the kind lines) or read from the English
// dictionary by key — never read back from the code under test. Every sweep reports how many it checked, and zero fails.
//
// Sport: not applicable — a streaming destination is sport-agnostic.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { propsOf, renderIsland, textOf, expandWithHooks } from "@/components/__tests__/_hook-harness";
import { messages, type MessageKey } from "@/lib/messages";
import { YOUTUBE_DISCONNECTED_LABEL, YOUTUBE_PRIVACIES } from "@/lib/youtube";
import { StreamTargetKind, type StreamTarget } from "@/server/api-v1/schemas";
import { FixtureDestinationPicker, TYPEAHEAD_RESET_MS, destinationRow, type FixtureDestinationPickerProps } from "../fixture-destination-picker";

const m = (k: MessageKey, vars: Record<string, string | number> = {}): string =>
  Object.entries(vars).reduce((s, [n, v]) => s.replaceAll(`{${n}}`, String(v)), messages[k] as string);
const msg = (k: MessageKey, vars?: Record<string, string | number>) => m(k, vars);
/** The Spanish dictionary's twin of `msg`: the archived-label swap is invisible in English (the database literal IS the English copy). */
const ES = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "dictionaries", "es", "ui.json"), "utf8")) as Record<string, string>;
const msgEs = (k: MessageKey, vars: Record<string, string | number> = {}): string =>
  Object.entries(vars).reduce((s, [n, v]) => s.replaceAll(`{${n}}`, String(v)), ES[k] ?? `MISSING:${k}`);

type View = NonNullable<StreamTarget["youtube"]>;
const channel = (id: string, title: string, y: Partial<View> = {}): StreamTarget => ({
  id, kind: "youtube", label: title, watchUrl: null, createdAt: "2026-10-20T10:00:00.000Z", keyHint: null, inUse: null,
  youtube: { connectionId: `c-${id}`, channelTitle: title, privacy: "unlisted", madeForKids: false, status: "connected", liveState: "enabled", termsOutdated: false, openBroadcasts: 0, ...y },
});
const key = (id: string, label: string, kind: StreamTarget["kind"] = "youtube"): StreamTarget => ({
  id, kind, label, watchUrl: null, createdAt: "2026-09-12T10:00:00.000Z", keyHint: "8hd", inUse: null, youtube: null,
});

// ─── the pure reading ────────────────────────────────────────────────────────────────────────────────────────────────────
describe("destinationRow: what one destination reads as", () => {
  it("a pasted key: the platform's own key line, for EVERY stored kind — and never a health badge (nothing is known about a key's health)", () => {
    let checked = 0;
    for (const kind of StreamTargetKind.options) {
      const row = destinationRow(msg, key("k", `Dest ${kind}`, kind));
      const expected =
        kind === "custom_rtmp" ? "Custom stream key"
        : kind === "youtube" ? "YouTube stream key"
        : kind === "facebook" ? "Facebook stream key"
        : kind === "twitch" ? "Twitch stream key"
        : "Kick stream key";
      expect(row.kind, kind).toBe(expected);
      expect(row.name, kind).toBe(`Dest ${kind}`);
      expect(row.health, `${kind}: a key has no health to claim`).toBeNull();
      checked++;
    }
    expect(checked, "every stored kind").toBe(StreamTargetKind.options.length);
    expect(checked).toBeGreaterThan(4);
  });

  it("a connected channel: 'YouTube channel · {who can watch}' for every privacy, distinct from a pasted YouTube key's line", () => {
    const WANT: Record<(typeof YOUTUBE_PRIVACIES)[number], string> = {
      unlisted: "YouTube channel · Unlisted",
      public: "YouTube channel · Public",
      private: "YouTube channel · Private",
    };
    let checked = 0;
    for (const privacy of YOUTUBE_PRIVACIES) {
      expect(destinationRow(msg, channel("c", "Riverside BC Live", { privacy })).kind, privacy).toBe(WANT[privacy]);
      checked++;
    }
    expect(checked).toBe(3);
    expect(destinationRow(msg, key("k", "Club stream key")).kind).not.toBe(WANT.unlisted);
  });

  it("health: ready shows NO badge; every other state shows its own — and a dead grant reads 'Reconnect needed' whatever the last live check said", () => {
    // Typed from spec §6.9 (the status names) and the T8 dictionary: [status, liveState] -> tone and badge text, null for ready.
    const MATRIX: [View["status"], View["liveState"], "warn" | "bad" | "neutral" | null, string | null][] = [
      ["connected", "enabled", null, null],
      ["connected", "not_enabled", "warn", "Not enabled for live"],
      ["connected", "blocked", "bad", "Live blocked"],
      ["connected", "unknown", "neutral", "Not checked yet"],
      ["reconnect_needed", "enabled", "bad", "Reconnect needed"],
      ["reconnect_needed", "not_enabled", "bad", "Reconnect needed"],
      ["reconnect_needed", "blocked", "bad", "Reconnect needed"],
      ["reconnect_needed", "unknown", "bad", "Reconnect needed"],
    ];
    let checked = 0;
    for (const [status, liveState, tone, text] of MATRIX) {
      const row = destinationRow(msg, channel("c", "Harbour Padel", { status, liveState }));
      expect(row.health === null ? null : { tone: row.health.tone, text: row.health.text }, `${status}/${liveState}`).toEqual(tone === null ? null : { tone, text });
      checked++;
    }
    expect(checked, "the whole matrix").toBe(MATRIX.length);
    // A liveState this build does not know (the wire may grow a value) fails closed — never "ready".
    const grown = destinationRow(msg, channel("c", "Harbour Padel", { liveState: "tomorrow" as View["liveState"] }));
    expect(grown.health?.tone).toBe("neutral");
  });

  it("a revoked connection's archived label is the dictionary's, never the database's English literal", () => {
    const row = destinationRow(msgEs, channel("c", YOUTUBE_DISCONNECTED_LABEL));
    expect(row.name).toBe(ES["streaming.youtube.disconnectedLabel"]);
    expect(row.name).not.toBe(YOUTUBE_DISCONNECTED_LABEL);
    expect(row.name, "the English literal is not what the Spanish page reads").not.toContain("disconnected");
    // …and the customer's own words pass through untouched.
    expect(destinationRow(msg, channel("c", "Riverside BC Live")).name).toBe("Riverside BC Live");
  });
});

// ─── the island, driven ──────────────────────────────────────────────────────────────────────────────────────────────────
/** Expand every hookless function child (Identity, HealthBadge, PlatformMark, YoutubeIcon), so what a customer READS is in the tree. */
const deep = (node: ReactNode): ReactElement[] => {
  const out: ReactElement[] = [];
  const visit = (n: ReactNode): void => {
    if (Array.isArray(n)) return void n.forEach(visit);
    if (!isValidElement(n)) return;
    out.push(n);
    if (typeof n.type === "function") visit(expandWithHooks(n.type as (p: unknown) => ReactNode, n.props));
    else visit((n.props as { children?: ReactNode }).children);
  };
  visit(node);
  return out;
};
const attr = (el: ReactElement, name: string): unknown => propsOf(el)[name];
const byTestId = (tree: ReactElement[], id: string): ReactElement | undefined => tree.find((el) => attr(el, "data-testid") === id);
const allByTestId = (tree: ReactElement[], id: string): ReactElement[] => tree.filter((el) => attr(el, "data-testid") === id);

const TARGETS: StreamTarget[] = [
  channel("t-ok", "Riverside BC Live"),
  channel("t-bad", "Harbour Padel", { status: "reconnect_needed" }),
  channel("t-warn", "Westside Hoops", { privacy: "public", liveState: "not_enabled" }),
  key("t-key", "Club stream key"),
  key("t-tw", "Twitch main", "twitch"),
];

function mount(over: Partial<FixtureDestinationPickerProps> = {}) {
  const picked: string[] = [];
  const props: FixtureDestinationPickerProps = { id: "stream-target-f1", targets: TARGETS, selectedId: "t-ok", onSelect: (id) => picked.push(id), ...over };
  const island = renderIsland(FixtureDestinationPicker, props, deep);
  const trigger = () => byTestId(island.tree(), "stream-target")!;
  const key = (k: string, mods: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {}) => {
    let prevented = false;
    (attr(trigger(), "onKeyDown") as (e: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; preventDefault: () => void }) => void)({ key: k, ...mods, preventDefault: () => { prevented = true; } });
    return prevented;
  };
  const open = () => island.tree().some((el) => attr(el, "data-testid") === "stream-target-list");
  const options = () => allByTestId(island.tree(), "stream-target-option");
  const active = () => attr(trigger(), "aria-activedescendant") as string | undefined;
  const activeTarget = () => {
    const o = options().find((el) => attr(el, "id") === active());
    return o ? attr(o, "data-target-id") : undefined;
  };
  return { island, props, picked, trigger, key, open, options, active, activeTarget };
}

describe("the picker, driven", () => {
  // The open list listens for a press outside it (`document`), which a node environment lacks: a registry stands in, so each test can
  // see whether anything is listening. `Node` is stubbed for the handler's `instanceof` guard.
  class FakeNode {}
  let listeners: Map<string, Set<(e: unknown) => void>>;
  beforeEach(() => {
    listeners = new Map();
    vi.stubGlobal("document", {
      addEventListener: (t: string, f: (e: unknown) => void) => void (listeners.get(t) ?? listeners.set(t, new Set()).get(t)!).add(f),
      removeEventListener: (t: string, f: (e: unknown) => void) => void listeners.get(t)?.delete(f),
    });
    vi.stubGlobal("Node", FakeNode);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("closed: a labelled combobox button naming the picked destination — mark, name, kind — and no list", () => {
    const p = mount();
    const t = p.trigger();
    expect(t.type).toBe("button");
    expect(attr(t, "type")).toBe("button");
    expect(attr(t, "role")).toBe("combobox");
    expect(attr(t, "aria-haspopup")).toBe("listbox");
    expect(attr(t, "aria-expanded")).toBe(false);
    expect(attr(t, "id"), "the panel's <label htmlFor> points here").toBe("stream-target-f1");
    expect(attr(t, "data-value")).toBe("t-ok");
    expect(p.open()).toBe(false);
    const tree = p.island.tree();
    expect(textOf(byTestId(tree, "stream-target-name")!)).toBe("Riverside BC Live");
    expect(textOf(byTestId(tree, "stream-target-kind")!)).toBe("YouTube channel · Unlisted");
    expect(tree.some((el) => attr(el, "data-platform-mark") === "youtube"), "the official icon leads the row").toBe(true);
    expect(byTestId(tree, "stream-target-health"), "a ready channel carries no badge").toBeUndefined();
  });

  it("the trigger shows an unhealthy pick's badge BEFORE anyone taps Go live", () => {
    const p = mount({ selectedId: "t-bad" });
    const badge = byTestId(p.island.tree(), "stream-target-health")!;
    expect(badge).toBeDefined();
    expect(attr(badge, "data-tone")).toBe("bad");
    expect(textOf(badge)).toBe("Reconnect needed");
  });

  it("open: one option per destination — all FIVE, exactly one selected — each with its own kind line, and a badge only on the two that need one", () => {
    const p = mount();
    (attr(p.trigger(), "onClick") as () => void)();
    expect(p.open()).toBe(true);
    expect(attr(p.trigger(), "aria-expanded")).toBe(true);
    const opts = p.options();
    expect(opts.length, "anti-vacuity: every destination listed").toBe(TARGETS.length);
    expect(opts.map((o) => attr(o, "data-target-id"))).toEqual(TARGETS.map((t) => t.id));
    expect(opts.filter((o) => attr(o, "aria-selected") === true).map((o) => attr(o, "data-target-id"))).toEqual(["t-ok"]);
    expect(opts.map((o) => attr(o, "role"))).toEqual(Array(5).fill("option"));
    const kinds = opts.map((o) => textOf(byTestId(deep(o), "stream-target-kind")!));
    expect(kinds).toEqual(["YouTube channel · Unlisted", "YouTube channel · Unlisted", "YouTube channel · Public", "YouTube stream key", "Twitch stream key"]);
    const badged = opts.map((o) => {
      const b = byTestId(deep(o), "stream-target-health");
      return b ? `${attr(o, "data-target-id")}:${textOf(b)}` : null;
    }).filter(Boolean);
    expect(badged).toEqual(["t-bad:Reconnect needed", "t-warn:Not enabled for live"]);
    // The official icon on the three API rows AND the pasted YouTube key's row; the Twitch row keeps its own tile.
    const marks = opts.map((o) => deep(o).find((el) => attr(el, "data-platform-mark") !== undefined && attr(el, "data-platform-mark") !== null)).map((el) => attr(el!, "data-platform-mark"));
    expect(marks).toEqual(["youtube", "youtube", "youtube", "youtube", "twitch"]);
  });

  it("picking an option hands over THAT destination's id and closes the list; a second open still lists everything", () => {
    const p = mount();
    (attr(p.trigger(), "onClick") as () => void)();
    const target = p.options().find((o) => attr(o, "data-target-id") === "t-warn")!;
    (attr(target, "onClick") as () => void)();
    expect(p.picked).toEqual(["t-warn"]);
    expect(p.open()).toBe(false);
    (attr(p.trigger(), "onClick") as () => void)();
    expect(p.options()).toHaveLength(5);
  });

  it("the trigger toggles: a second press closes", () => {
    const p = mount();
    (attr(p.trigger(), "onClick") as () => void)();
    expect(p.open()).toBe(true);
    (attr(p.trigger(), "onClick") as () => void)();
    expect(p.open()).toBe(false);
    expect(p.picked, "closing picks nothing").toEqual([]);
  });

  it("keyboard: ArrowDown opens on the picked row and moves the active option; ArrowUp moves back; both stop at the ends (no wrap)", () => {
    const p = mount({ selectedId: "t-bad" });
    expect(p.key("ArrowDown"), "preventDefault: the page must not scroll").toBe(true);
    expect(p.open()).toBe(true);
    expect(p.activeTarget(), "opens on the picked row").toBe("t-bad");
    p.key("ArrowDown");
    expect(p.activeTarget()).toBe("t-warn");
    p.key("ArrowDown"); p.key("ArrowDown"); p.key("ArrowDown"); p.key("ArrowDown");
    expect(p.activeTarget(), "stops at the last").toBe("t-tw");
    p.key("ArrowUp");
    expect(p.activeTarget()).toBe("t-key");
    for (let i = 0; i < 9; i++) p.key("ArrowUp");
    expect(p.activeTarget(), "stops at the first").toBe("t-ok");
  });

  it("keyboard: Home and End jump; Enter and Space pick the ACTIVE option (not the previously selected one) and close; Escape closes and picks nothing", () => {
    const p = mount();
    p.key("ArrowDown");
    p.key("End");
    expect(p.activeTarget()).toBe("t-tw");
    p.key("Home");
    expect(p.activeTarget()).toBe("t-ok");
    p.key("End");
    p.key("Enter");
    expect(p.picked).toEqual(["t-tw"]);
    expect(p.open()).toBe(false);
    p.key(" ");
    expect(p.open(), "Space opens a closed list").toBe(true);
    expect(p.activeTarget(), "on the picked row (the prop still says t-ok)").toBe("t-ok");
    p.key("ArrowDown");
    p.key(" ");
    expect(p.picked, "Space picks the active option, the one after the picked row").toEqual(["t-tw", "t-bad"]);
    // Escape: close, pick nothing.
    p.key("Enter");
    expect(p.open(), "Enter opens a closed list").toBe(true);
    expect(p.key("Escape")).toBe(true);
    expect(p.open()).toBe(false);
    expect(p.picked, "Escape picks nothing").toEqual(["t-tw", "t-bad"]);
    // Escape on a closed list is not swallowed (a parent's own Escape handler still runs).
    expect(p.key("Escape")).toBe(false);
  });

  it("keyboard: Tab closes the list and picks nothing; Home/End on a closed list do nothing", () => {
    const p = mount();
    p.key("ArrowDown");
    p.key("ArrowDown");
    p.key("Tab");
    expect(p.open()).toBe(false);
    expect(p.picked, "walking past picks nothing").toEqual([]);
    expect(p.key("End"), "closed: End is the page's").toBe(false);
    expect(p.open()).toBe(false);
  });

  it("a press OUTSIDE closes the open list; a press inside does not; no listener is left behind once it is closed", () => {
    const inside = new FakeNode();
    const outside = new FakeNode();
    const p = mount();
    // The harness has no DOM to attach the root ref to, so give it the one thing the handler asks of it: `contains`.
    (attr(byTestId(p.island.tree(), "stream-target-picker")!, "ref") as { current: unknown }).current = { contains: (n: unknown) => n === inside };
    const live = () => listeners.get("pointerdown")?.size ?? 0;
    expect(live(), "nothing listens while closed").toBe(0);
    (attr(p.trigger(), "onClick") as () => void)();
    expect(live(), "one listener while open").toBe(1);
    const press = [...listeners.get("pointerdown")!][0]!;
    press({ target: inside });
    expect(p.open(), "a press inside is the picker's own").toBe(true);
    press({ target: outside });
    expect(p.open(), "a press outside closes it").toBe(false);
    expect(live(), "closed: the listener is gone").toBe(0);
    expect(p.picked, "closing by an outside press picks nothing").toEqual([]);
  });

  it("the panel's 'Use another destination' (openSignal) opens the list on each INCREASE — and a mount with a non-zero signal opens nothing", () => {
    const fresh = mount({ openSignal: 3 });
    expect(fresh.open(), "baseline: mounting with a signal already counted opens nothing").toBe(false);
    const p = mount({ openSignal: 0 });
    expect(p.open()).toBe(false);
    p.island.rerender({ ...p.props, openSignal: 1 });
    expect(p.open(), "the signal opened it").toBe(true);
    (attr(p.trigger(), "onClick") as () => void)();
    expect(p.open()).toBe(false);
    p.island.rerender({ ...p.props, openSignal: 1 });
    expect(p.open(), "the same value again opens nothing").toBe(false);
    p.island.rerender({ ...p.props, openSignal: 2 });
    expect(p.open(), "the next increase opens it again").toBe(true);
    expect(p.activeTarget(), "on the picked row").toBe("t-ok");
  });

  it("pressing the row that is already picked closes the list and saves nothing — a re-pick would PUT the same choice again", () => {
    const p = mount({ selectedId: "t-ok" });
    (attr(p.trigger(), "onClick") as () => void)();
    const picked = p.options().find((o) => attr(o, "data-target-id") === "t-ok")!;
    expect(attr(picked, "aria-selected"), "premise: it is the selected row").toBe(true);
    (attr(picked, "onClick") as () => void)();
    expect(p.picked, "a tap on the picked row selects nothing new").toEqual([]);
    expect(p.open(), "…and still closes the list").toBe(false);
    // The keyboard path is the same: Enter opens on the picked row, Enter again picks it — nothing is handed over.
    p.key("Enter");
    expect(p.open()).toBe(true);
    p.key("Enter");
    expect(p.picked).toEqual([]);
    expect(p.open()).toBe(false);
    // The positive pair: a DIFFERENT row still hands its id over.
    p.key("Enter");
    p.key("ArrowDown");
    p.key("Enter");
    expect(p.picked).toEqual(["t-bad"]);
  });

  // B4 fix round 1, I-3 (WCAG 2.4.7 focus visible, 1.4.11 non-text contrast): the arrow keys move `aria-activedescendant`, and that is all a
  // keyboard user has to see where they are — the row's background (slate-50 for the active row, purple-50 for the selected one) is about
  // 1.04:1 against white, so neither could be told from a plain row. The indicator is an inset ring in the house accent, on the active row
  // only and whether or not it is also the selected one.
  describe("the keyboard-active row is visibly marked (I-3)", () => {
    /** The house accent (`--ps-accent`, globals.css) — the colour the keyboard ring is drawn in everywhere else; Tailwind's violet-600. */
    const ACCENT = /--ps-accent:\s*(#[0-9a-f]{6})/i.exec(readFileSync(join(__dirname, "..", "..", "..", "app", "globals.css"), "utf8"))![1]!;
    const channelOf = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    const luminance = (hex: string) => { const [r, g, b] = channelOf(hex) as [number, number, number]; return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const contrast = (a: string, b: string) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]; return (hi + 0.05) / (lo + 0.05); };
    const RING = ["ring-2", "ring-inset", "ring-violet-600"];
    const classesOf = (el: ReactElement) => String(attr(el, "className")).split(/\s+/);
    const ringed = (p: ReturnType<typeof mount>) => p.options().filter((o) => RING.every((t) => classesOf(o).includes(t))).map((o) => attr(o, "data-target-id"));

    it("the ring's colour is the house accent and clears 3:1 against white and against the selected row's tint (the tint's own contrast with white is NOT the signal: ~1.04)", () => {
      expect(ACCENT.toLowerCase(), "the declaration the ring token stands for").toBe("#7c3aed");
      expect(contrast(ACCENT, "#ffffff")).toBeGreaterThanOrEqual(3);
      expect(contrast(ACCENT, "#faf5ff"), "against purple-50, the selected row's background").toBeGreaterThanOrEqual(3);
      expect(contrast("#faf5ff", "#ffffff"), "premise: the old selected-row tint alone was no indicator").toBeLessThan(1.1);
      expect(contrast("#f8fafc", "#ffffff"), "premise: nor was the old active-row tint (slate-50)").toBeLessThan(1.1);
    });

    it("ArrowDown / ArrowUp / Home / End: exactly the active row carries the ring, at every step — including when it is the SELECTED row (which keeps its own tint and check)", () => {
      const p = mount({ selectedId: "t-ok" });
      expect(ringed(p), "closed: no list, no ring").toEqual([]);
      p.key("Enter");
      expect(p.activeTarget(), "premise: opening lands on the selected row").toBe("t-ok");
      expect(ringed(p), "active AND selected: still ringed").toEqual(["t-ok"]);
      expect(classesOf(p.options().find((o) => attr(o, "data-target-id") === "t-ok")!), "…and keeps the selected tint").toContain("bg-purple-50");
      let checked = 0;
      for (const k of ["ArrowDown", "ArrowDown", "ArrowDown", "ArrowDown", "ArrowUp", "End", "Home"]) {
        p.key(k);
        expect(ringed(p), `after ${k}: one ring, on the active row`).toEqual([p.activeTarget()]);
        // The selected row, once it is NOT active, carries its tint and no ring: the two signals are independent.
        const sel = p.options().find((o) => attr(o, "aria-selected") === true)!;
        if (attr(sel, "data-target-id") !== p.activeTarget()) {
          expect(classesOf(sel), `after ${k}: the selected row alone`).toContain("bg-purple-50");
          expect(RING.some((t) => classesOf(sel).includes(t)), `after ${k}: the selected row is not the active one`).toBe(false);
        }
        checked++;
      }
      expect(checked, "anti-vacuity").toBe(7);
    });

    it("the ring follows a pointer too (a hover makes a row active), and a list with a different selection rings the right row", () => {
      const p = mount({ selectedId: "t-warn" });
      p.key("Enter");
      expect(ringed(p)).toEqual(["t-warn"]);
      const hovered = p.options().find((o) => attr(o, "data-target-id") === "t-key")!;
      (attr(hovered, "onMouseEnter") as () => void)();
      expect(ringed(p), "the hovered row now carries it, and the selected one no longer does").toEqual(["t-key"]);
    });
  });

  it("a list that shrinks while it is open never leaves the active descendant on a row that is gone", () => {
    const p = mount({ selectedId: "t-ok" });
    p.key("Enter");
    p.key("End");
    expect(p.activeTarget(), "premise: active is the last of five").toBe("t-tw");
    p.island.rerender({ ...p.props, targets: TARGETS.slice(0, 2) });
    expect(p.options()).toHaveLength(2);
    expect(p.active(), "aria-activedescendant names a row that exists").toBeDefined();
    expect(p.activeTarget(), "clamped to the last row left").toBe("t-bad");
    expect(p.options().filter((o) => attr(o, "data-active") === "true"), "exactly one row is active").toHaveLength(1);
    p.key("Enter");
    expect(p.picked, "Enter picks the clamped row, not a ghost").toEqual(["t-bad"]);
  });

  describe("typeahead: the first letters of a destination's name jump to it", () => {
    const NAMES = ["Harbour Padel", "Hoops Arena", "Hockey Hall", "Westside Court 1", "Westside Court 2", "Riverside"];
    const LIST = NAMES.map((n, i) => key(`t${i}`, n));
    afterEach(() => vi.useRealTimers());

    it("buffered prefix: 'h' lands on the first H, 'ho' on Hoops (a one-letter match would stay put), 'hoc' on Hockey; a miss moves nothing", () => {
      vi.useFakeTimers();
      const p = mount({ targets: LIST, selectedId: "t5" });
      expect(p.open()).toBe(false);
      expect(p.key("h"), "a handled letter is not left to the browser").toBe(true);
      expect(p.open(), "typing on a closed list opens it").toBe(true);
      expect(p.activeTarget()).toBe("t0");
      p.key("o");
      expect(p.activeTarget(), "'ho' is a LONGER prefix: Hoops Arena, not Harbour Padel").toBe("t1");
      p.key("c");
      expect(p.activeTarget()).toBe("t2");
      expect(p.key("z"), "no name starts 'hocz': nothing handled").toBe(false);
      expect(p.activeTarget(), "a miss moves nothing").toBe("t2");
      expect(p.key("Shift"), "a modifier is not a letter").toBe(false);
      expect(p.activeTarget()).toBe("t2");
      expect(p.picked, "typing alone picks nothing").toEqual([]);
    });

    it("a pause starts it over; a space mid-word belongs to the buffer; Enter then picks the typed row; a lone space after a pause still picks", () => {
      vi.useFakeTimers();
      const p = mount({ targets: LIST, selectedId: "t5" });
      p.key("h");
      p.key("o");
      p.key("c");
      vi.advanceTimersByTime(TYPEAHEAD_RESET_MS + 1);
      p.key("w");
      expect(p.activeTarget(), "after a pause 'w' is a fresh buffer — Westside, not 'hocw'").toBe("t3");
      // Within the window the buffer keeps growing, spaces and digits included: 'westside court 2' is the SECOND court.
      for (const ch of "estside court 2") p.key(ch);
      expect(p.activeTarget()).toBe("t4");
      vi.advanceTimersByTime(TYPEAHEAD_RESET_MS + 1);
      p.key(" ");
      expect(p.picked, "a space after a pause is the picker's own Space: it picks the active row").toEqual(["t4"]);
      expect(p.open()).toBe(false);
    });

    it("a PREFIX, never a substring: 'a' goes to the name that STARTS with it, past an earlier name that merely contains it", () => {
      vi.useFakeTimers();
      const list = [key("a", "Court Alpha"), key("b", "Alpha Hall"), key("c", "Zulu")];
      const p = mount({ targets: list, selectedId: "c" });
      p.key("a");
      expect(p.activeTarget(), "'Court Alpha' contains an 'a' but does not start with one").toBe("b");
      p.key("l");
      expect(p.activeTarget(), "'al' is still Alpha Hall").toBe("b");
      expect(p.key("q"), "'alq': no name starts with it").toBe(false);
      expect(p.activeTarget(), "a miss moves nothing").toBe("b");
    });

    it("a chord is not typing: Ctrl, Cmd or Alt with a letter is the browser's shortcut — never handled, never opens the list, never moves", () => {
      vi.useFakeTimers();
      let checked = 0;
      for (const mod of ["ctrlKey", "metaKey", "altKey"] as const) {
        const p = mount({ targets: LIST, selectedId: "t5" });
        expect(p.key("h", { [mod]: true }), `${mod}+h is left to the browser (no preventDefault)`).toBe(false);
        expect(p.open(), `${mod}+h opens nothing`).toBe(false);
        // The positive pair, on the same mount: the plain letter IS typeahead, so the chord test above can fail.
        expect(p.key("h"), `${mod}: plain h is handled`).toBe(true);
        expect(p.activeTarget()).toBe("t0");
        checked++;
      }
      expect(checked, "anti-vacuity: all three modifiers").toBe(3);
    });

    it("it matches the NAME a customer reads, case-insensitively — never the kind line under it", () => {
      vi.useFakeTimers();
      const list = [key("a", "Zebra"), channel("b", YOUTUBE_DISCONNECTED_LABEL), key("c", "Quarry")];
      const p = mount({ targets: list, selectedId: "a" });
      p.key("Q");
      expect(p.activeTarget(), "uppercase finds a name regardless of case").toBe("c");
      vi.advanceTimersByTime(TYPEAHEAD_RESET_MS + 1);
      p.key("y");
      expect(p.activeTarget(), "'y': the archived channel's DISPLAYED name starts 'YouTube channel (disconnected)'").toBe("b");
      vi.advanceTimersByTime(TYPEAHEAD_RESET_MS + 1);
      // "Zebra"'s kind line is "YouTube stream key", which also starts with Y — it must not be a match.
      p.key("s");
      expect(p.activeTarget(), "no NAME starts with 's' — the kind lines 'stream key' are not searched").toBe("b");
    });
  });

  it("…and puts focus on the trigger when it opens that way — never on a mount, never on the same value again", () => {
    const focused: string[] = [];
    const recordFocus = (p: ReturnType<typeof mount>, who: string) => {
      // The harness has no DOM to attach the trigger's ref to: hand it the one thing the effect asks of it.
      (attr(p.trigger(), "ref") as { current: unknown }).current = { focus: () => focused.push(who) };
    };
    const fresh = mount({ openSignal: 3 });
    recordFocus(fresh, "fresh");
    fresh.island.rerender({ ...fresh.props, openSignal: 3 });
    expect(focused, "a mount that already carries a signal focuses nothing").toEqual([]);
    const p = mount({ openSignal: 0 });
    recordFocus(p, "p");
    p.island.rerender({ ...p.props, openSignal: 1 });
    expect(focused, "the first increase focuses the trigger").toEqual(["p"]);
    p.island.rerender({ ...p.props, openSignal: 1 });
    expect(focused, "the same value again does nothing").toEqual(["p"]);
    p.island.rerender({ ...p.props, openSignal: 2 });
    expect(focused, "the next increase focuses it again").toEqual(["p", "p"]);
  });

  it("nothing picked (or a pick the list no longer holds): the prompt, no selected option, an empty data-value — never another destination chosen for them", () => {
    let checked = 0;
    for (const selectedId of [null, "t-removed"]) {
      const p = mount({ selectedId });
      expect(textOf(byTestId(p.island.tree(), "stream-target-placeholder")!), String(selectedId)).toBe(m("stream.dest.pick"));
      expect(attr(p.trigger(), "data-value")).toBe("");
      expect(byTestId(p.island.tree(), "stream-target-name")).toBeUndefined();
      (attr(p.trigger(), "onClick") as () => void)();
      expect(p.options().filter((o) => attr(o, "aria-selected") === true), String(selectedId)).toEqual([]);
      expect(p.options()).toHaveLength(5);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("invalid paints the field red and says so to assistive tech; describedBy points at the refusal; neither is set otherwise", () => {
    const bad = mount({ invalid: true, describedBy: "why" });
    expect(attr(bad.trigger(), "aria-invalid")).toBe(true);
    expect(attr(bad.trigger(), "aria-describedby")).toBe("why");
    expect(String(attr(bad.trigger(), "className"))).toMatch(/\bborder-red-300\b/);
    const fine = mount();
    expect(attr(fine.trigger(), "aria-invalid")).toBeUndefined();
    expect(attr(fine.trigger(), "aria-describedby")).toBeUndefined();
    expect(String(attr(fine.trigger(), "className"))).not.toMatch(/border-red/);
  });

  it("the health badge sits on its OWN line in the name's column, in every open row and on the trigger: a badge BESIDE the name takes the width the name needs (\"Alph...\", \"Bravo Riv...\")", () => {
    // `deep` flattens the tree, so a sibling and a descendant look alike. Structure needs parents: the element whose DIRECT children
    // hold the name is the text column, and the badge must live in that column, after the name and the kind line - never beside it.
    const kidsOf = (el: ReactElement): ReactElement[] => {
      const raw = typeof el.type === "function" ? expandWithHooks(el.type as (p: unknown) => ReactNode, el.props) : (el.props as { children?: ReactNode }).children;
      const out: ReactElement[] = [];
      const visit = (n: ReactNode): void => {
        if (Array.isArray(n)) return void n.forEach(visit);
        if (isValidElement(n)) out.push(n);
      };
      visit(raw);
      return out;
    };
    const columnOf = (root: ReactElement): ReactElement => {
      const col = deep(root).find((el) => kidsOf(el).some((k) => attr(k, "data-testid") === "stream-target-name"));
      expect(col, "the name has a text column").toBeDefined();
      return col!;
    };
    const order = (root: ReactElement, ids: string[]) => ids.map((id) => deep(root).findIndex((el) => attr(el, "data-testid") === id));
    let checked = 0;
    const p = mount({ selectedId: "t-bad" });
    (attr(p.trigger(), "onClick") as () => void)();
    const subjects = [{ who: "trigger", root: p.trigger() }, ...p.options().map((o) => ({ who: String(attr(o, "data-target-id")), root: o }))];
    for (const { who, root } of subjects) {
      const badges = allByTestId(deep(root), "stream-target-health");
      const wants = who === "trigger" || who === "t-bad" || who === "t-warn";
      expect(badges.length, `${who}: a badge exactly where the health is not ready`).toBe(wants ? 1 : 0);
      if (!wants) continue;
      const column = columnOf(root);
      expect(allByTestId(deep(column), "stream-target-health"), `${who}: the badge is INSIDE the name's column, not a sibling of it`).toHaveLength(1);
      const [name, kind, badge] = order(column, ["stream-target-name", "stream-target-kind", "stream-target-health"]);
      expect(name, `${who}: name found`).toBeGreaterThanOrEqual(0);
      expect(kind, `${who}: the kind line follows the name`).toBeGreaterThan(name!);
      expect(badge, `${who}: the badge comes after the kind line`).toBeGreaterThan(kind!);
      // Nothing between the row and its text column can cap the column's width: no capped wrapper holds a badge beside it.
      expect(deep(root).filter((el) => /max-w-\[/.test(String(attr(el, "className") ?? ""))), `${who}: no percentage-capped badge wrapper`).toEqual([]);
      checked++;
    }
    expect(checked, "anti-vacuity: the trigger and both badged rows").toBe(3);
  });

  it("every row is a 44px-plus tap target and the chain truncates: min-h-14 rows, min-w-0 down the chain (a 43-character channel name must not widen the page)", () => {
    const long = "Riverside Basketball Club Official Live Channel 2026";
    const p = mount({ targets: [channel("t-long", long), ...TARGETS] , selectedId: "t-long" });
    (attr(p.trigger(), "onClick") as () => void)();
    for (const el of [p.trigger(), ...p.options()]) {
      const tokens = String(attr(el, "className")).split(/\s+/);
      expect(tokens).toContain("min-h-14");
      expect(tokens).toContain("min-w-0");
    }
    const name = byTestId(p.island.tree(), "stream-target-name")!;
    expect(String(attr(name, "className")).split(/\s+/)).toContain("truncate");
    expect(textOf(name)).toBe(long);
    expect(p.options()).toHaveLength(6);
    // A name the box clips is still readable: it is the title, on the trigger's copy and on every row's.
    const names = [name, ...p.options().map((o) => byTestId(deep(o), "stream-target-name")!)];
    for (const n of names) expect(attr(n, "title"), "a clipped name stays readable").toBe(textOf(n));
    expect(attr(name, "title")).toBe(long);
    expect(names.length, "anti-vacuity: the trigger and all six rows").toBe(7);
  });
});
