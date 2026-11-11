// The fixture console's header panel bar (owner request 2026-11-11): Stream · Remote scoring · Lineup · Match rules ·
// Match actions, the same order for EVERY sport, one panel open at a time. The pure rules are pinned in
// lib/__tests__/fixture-console-panels.test.ts; this file drives the REAL console — its bar through every shipped sport
// module, and its buttons through real clicks (the hooks island), so the seam is proven through producer and consumer.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { builtinModules } from "@seazn/engine/sports";
import { FixtureConsole, type SideInfo } from "@/components/v2/fixture-console";
import { lineupCatalogFor } from "@/server/usecases/lineup-catalog";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import type { ComponentProps, ReactElement } from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => "/o/org/c/comp/d/div/f/1",
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/components/ui/confirm-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ui/confirm-provider")>()),
  useConfirm: () => async () => true,
}));

// The R7 gate (fixture-console-lineup-gate.test.tsx): a module that nominates one unit and admits no bench has no lineup
// to pick. Written from that ruling, not read back from `lineupEditorApplies`.
const NO_LINEUP = new Set(["boardgame", "carrom", "generic"]);
const BAR_ORDER = ["stream", "handover", "lineup", "rules", "actions"] as const;

const side = (id: string, name: string): SideInfo => ({
  id,
  name,
  kind: "team",
  members: [
    { person_id: "00000000-0000-0000-0000-000000000001", full_name: "Alex Stone", squad_number: 1, default_position_key: null, is_captain: false, roles: [] },
  ],
  lineup: [],
});

type ConsoleProps = ComponentProps<typeof FixtureConsole>;
type Island = ReturnType<typeof renderIsland<ConsoleProps>>;

function consoleProps(sportKey: string, over: Partial<ConsoleProps> = {}): ConsoleProps {
  const mod = builtinModules.find((m) => m.key === sportKey)!;
  const catalog = lineupCatalogFor(mod, {});
  return {
    fixture: { id: "f1", status: "scheduled", scheduled_at: null, venue_name: null, court_name: null, round_no: 1 },
    sport: {
      key: mod.key,
      config: {},
      scorerLabel: mod.officialLabel.scorer,
      positionGroups: catalog.groups,
      roles: catalog.roles ?? [],
      lineupSize: catalog.lineup.size,
      benchMax: catalog.lineup.benchMax ?? 0,
    },
    home: side("e1", "Home"),
    away: side("e2", "Away"),
    initialState: { status: "scheduled", last_seq: 0, summary: null, state: null, outcome: null },
    initialEvents: [],
    canEdit: true,
    canOrganise: true,
    stageKind: "league",
    deviceHandover: true,
    stream: { mode: "stop-only" },
    matchFormatLine: "Best of 3",
    viewerPlan: "community",
    ...over,
  } as ConsoleProps;
}

/** The bar's buttons, in document order, as panel keys: only a bar button carries `aria-controls="console-panel-<key>"`. */
function barOf(html: string): string[] {
  expect(html, "the bar renders").toContain('data-role="console-panel-bar"');
  return [...html.matchAll(/<button[^>]*aria-controls="console-panel-([a-z]+)"/g)].map((m) => m[1]!);
}

describe("the panel bar, swept over every shipped sport module", () => {
  const rows: { sport: string; lineup: boolean; bar: string[] }[] = [];
  for (const mod of builtinModules) {
    const html = renderToStaticMarkup(<FixtureConsole {...consoleProps(mod.key)} />);
    rows.push({ sport: mod.key, lineup: NO_LINEUP.has(mod.key) ? false : true, bar: barOf(html) });
  }

  it("anti-vacuity: the sweep saw every module, at least the ten the product ships", () => {
    expect(rows.length).toBe(builtinModules.length);
    expect(rows.length).toBeGreaterThanOrEqual(10);
  });

  for (const mod of builtinModules) {
    it(`${mod.key}: Stream · Remote scoring · ${NO_LINEUP.has(mod.key) ? "(no Lineup)" : "Lineup"} · Match rules · Match actions`, () => {
      const row = rows.find((r) => r.sport === mod.key)!;
      const expected = BAR_ORDER.filter((b) => b !== "lineup" || row.lineup);
      expect(row.bar).toEqual(expected);
    });
  }
});

describe("phone placement: the bar sits BELOW the pad, in one DOM (design of record 2026-09-02, chrome down)", () => {
  /** The `max-md:order-N` of the element carrying `marker` (attribute text), read from its own class list. */
  const phoneOrder = (html: string, marker: string): number => {
    const at = html.indexOf(marker);
    expect(at, `${marker} rendered`).toBeGreaterThan(-1);
    const open = html.lastIndexOf("<", at);
    const tag = html.slice(open, html.indexOf(">", at));
    const m = tag.match(/max-md:order-(\d+)/);
    expect(m, `${marker} carries an explicit phone order`).not.toBeNull();
    return Number(m![1]);
  };

  it("pad (scoring card) < panel group < everything after the pad; from md the group is `contents` (header position unchanged)", () => {
    let swept = 0;
    for (const sport of ["football", "badminton", "boardgame"]) {
      const html = renderToStaticMarkup(<FixtureConsole {...consoleProps(sport, { initialPanel: "rules" })} />);
      const pad = phoneOrder(html, 'data-role="console-scoring"');
      const panels = phoneOrder(html, 'data-role="console-panels"');
      const after = phoneOrder(html, 'data-role="console-after-pad"');
      expect([pad, panels, after], `${sport}: phone order pad, panels, after-pad`).toEqual([1, 2, 3]);
      expect(html).toMatch(/data-role="console-panels"[^>]*class="[^"]*\bmd:contents\b/);
      // the opened panel renders INSIDE the same group as the bar: next to it, not elsewhere on the page
      const groupStart = html.indexOf('data-role="console-panels"');
      const barAt = html.indexOf('data-role="console-panel-bar"');
      const panelAt = html.indexOf('data-panel="rules"');
      const padAt = html.indexOf('data-role="console-scoring"');
      expect(groupStart).toBeLessThan(barAt);
      expect(barAt).toBeLessThan(panelAt);
      expect(panelAt).toBeLessThan(padAt);
      swept++;
    }
    expect(swept).toBe(3);
  });
});

describe("what hides each button", () => {
  const html = (over: Partial<ConsoleProps>, sport = "football") => renderToStaticMarkup(<FixtureConsole {...consoleProps(sport, over)} />);

  it("each button disappears on its own gate and nothing else's (and the full bar is the positive pair)", () => {
    const full = barOf(html({}));
    expect(full).toEqual([...BAR_ORDER]);
    const cases: [string, Partial<ConsoleProps>, string][] = [
      ["no stream mount", { stream: undefined }, "stream"],
      ["no hand-over (the page says no)", { deviceHandover: false }, "handover"],
      ["no format line and no block", { matchFormatLine: undefined }, "rules"],
      ["an official scorer (no organiser actions)", { canOrganise: false }, "actions"],
    ];
    let checked = 0;
    for (const [name, over, gone] of cases) {
      expect(barOf(html(over)), name).toEqual(full.filter((b) => b !== gone));
      checked++;
    }
    expect(checked).toBe(4);
    // a TBD side: no lineup, no hand-over, no actions (nothing to score) — Stream and the rules line remain
    expect(barOf(html({ away: null })), "TBD side").toEqual(["stream", "rules"]);
  });
});

describe("real clicks: ONE panel open at a time across all five", () => {
  const PANELS = ["stream", "handover", "lineup", "rules", "actions"] as const;

  /** The island's bar buttons, keyed by panel: `PanelButton`s carry `panel`, `StreamControl` carries `onToggle`. */
  function buttons(island: Island): Record<string, ReactElement> {
    const out: Record<string, ReactElement> = {};
    for (const el of island.tree()) {
      const p = propsOf(el);
      if (typeof el.type !== "function") continue;
      if (typeof p.panel === "string" && typeof p.onClick === "function") out[p.panel] = el;
      else if (typeof p.onToggle === "function" && p.fixtureId !== undefined) out.stream = el;
    }
    return out;
  }
  const press = (el: ReactElement) => {
    const p = propsOf(el);
    ((p.onClick ?? p.onToggle) as () => void)();
  };
  /** Panels currently showing: a `ConsolePanel` that is not `hidden`. */
  const showing = (island: Island) =>
    island
      .tree()
      .filter((el) => typeof el.type === "function" && typeof propsOf(el).panel === "string" && typeof propsOf(el).closeLabel === "string" && propsOf(el).hidden !== true)
      .map((el) => propsOf(el).panel as string);

  it("opening each panel in turn from every starting panel leaves exactly one showing after every step (5 x 5), Match actions included", () => {
    const island = renderIsland(FixtureConsole, consoleProps("football"));
    expect(Object.keys(buttons(island)).sort(), "the bar offers all five").toEqual([...PANELS].sort());
    expect(showing(island), "nothing open on arrival").toEqual([]);
    let steps = 0;
    for (const from of PANELS) {
      for (const to of PANELS) {
        press(buttons(island)[from]!); // open `from` (or close it if left open by the previous step)
        if (!showing(island).includes(from)) press(buttons(island)[from]!);
        expect(showing(island), `after opening ${from}`).toEqual([from]);
        press(buttons(island)[to]!);
        expect(showing(island), `${from} -> ${to}`).toEqual(from === to ? [] : [to]);
        steps++;
        if (showing(island).length > 0) press(buttons(island)[showing(island)[0]!]!); // close, back to none
        expect(showing(island)).toEqual([]);
      }
    }
    expect(steps, "anti-vacuity: 25 transitions").toBe(25);
  });

  it("the close X of each panel closes it", () => {
    const island = renderIsland(FixtureConsole, consoleProps("football"));
    let closed = 0;
    for (const k of PANELS) {
      press(buttons(island)[k]!);
      const panel = island.tree().find((el) => typeof el.type === "function" && propsOf(el).panel === k && typeof propsOf(el).onClose === "function" && propsOf(el).hidden !== true)!;
      expect(panel, `${k} is showing`).toBeDefined();
      expect(typeof propsOf(panel).closeLabel).toBe("string");
      (propsOf(panel).onClose as () => void)();
      expect(showing(island), `${k} closed by its X`).toEqual([]);
      closed++;
    }
    expect(closed).toBe(5);
  });
});

describe("Remote scoring closes itself after 20 s idle — through the real console", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const open = (island: Island, panel: string) => {
    const el = island
      .tree()
      .find(
        (e) =>
          typeof e.type === "function" &&
          ((propsOf(e).panel === panel && typeof propsOf(e).onClick === "function") ||
            (panel === "stream" && typeof propsOf(e).onToggle === "function" && propsOf(e).fixtureId !== undefined)),
      )!;
    ((propsOf(el).onClick ?? propsOf(el).onToggle) as () => void)();
  };
  const panelEl = (island: Island, panel: string) =>
    island.tree().find((e) => typeof e.type === "function" && propsOf(e).panel === panel && typeof propsOf(e).closeLabel === "string" && propsOf(e).hidden !== true);

  it("closes 20 s after opening when nothing is touched; a pointer/keyboard/focus/copy inside restarts the clock; the other panels never close by themselves", () => {
    const island = renderIsland(FixtureConsole, consoleProps("football"));
    open(island, "handover");
    expect(panelEl(island, "handover")).toBeDefined();
    vi.advanceTimersByTime(19_000);
    expect(panelEl(island, "handover"), "still open at 19 s").toBeDefined();
    vi.advanceTimersByTime(1_000);
    expect(panelEl(island, "handover"), "closed at 20 s").toBeUndefined();

    // each kind of interaction, applied at 19 s, buys a fresh 20 s
    let restarted = 0;
    for (const kind of ["onPointerDownCapture", "onKeyDownCapture", "onFocusCapture", "onCopyCapture"]) {
      open(island, "handover");
      vi.advanceTimersByTime(19_000);
      const handlers = propsOf(panelEl(island, "handover")!).extraProps as Record<string, () => void>;
      handlers[kind]!();
      vi.advanceTimersByTime(19_000);
      expect(panelEl(island, "handover"), `${kind}: open 38 s after opening`).toBeDefined();
      vi.advanceTimersByTime(1_000);
      expect(panelEl(island, "handover"), `${kind}: closed 20 s after the interaction`).toBeUndefined();
      restarted++;
    }
    expect(restarted).toBe(4);

    // Stream, Lineup, Match rules and Match actions stay open however long they sit
    for (const k of ["stream", "lineup", "rules", "actions"]) {
      open(island, k);
      vi.advanceTimersByTime(10 * 60_000);
      expect(panelEl(island, k), `${k} does not auto-close`).toBeDefined();
      open(island, k); // toggle closed
    }
    island.unmount();
  });
});

describe("leaving the Lineup panel over unsaved edits asks in-page first", () => {
  it("clean: X closes at once; dirty: X and any other button raise the in-page prompt, Keep stays, Discard leaves and remounts the editors", () => {
    const island = renderIsland(FixtureConsole, consoleProps("football"));
    const tree = () => island.tree();
    const byTestid = (id: string) => tree().filter((e) => propsOf(e)["data-testid"] === id);
    const pressBar = (panel: string) => {
      const el = tree().find((e) => typeof e.type === "function" && propsOf(e).panel === panel && typeof propsOf(e).onClick === "function")!;
      (propsOf(el).onClick as () => void)();
    };
    const lineupPanel = () => tree().find((e) => typeof e.type === "function" && propsOf(e).panel === "lineup" && typeof propsOf(e).closeLabel === "string")!;
    const editors = () => tree().filter((e) => typeof e.type === "function" && typeof propsOf(e).onDirtyChange === "function");
    const showingLineup = () => propsOf(lineupPanel()).hidden !== true;

    // clean: X closes immediately, no prompt
    pressBar("lineup");
    expect(showingLineup()).toBe(true);
    expect(editors(), "both sides' editors are mounted").toHaveLength(2);
    (propsOf(lineupPanel()).onClose as () => void)();
    expect(showingLineup()).toBe(false);
    expect(byTestid("lineup-discard-prompt")).toHaveLength(0);

    // dirty: an edit on the home side
    pressBar("lineup");
    const keysBefore = tree().filter((e) => e.key !== null && String(e.key).startsWith("e1-")).map((e) => String(e.key));
    (propsOf(editors()[0]!).onDirtyChange as (d: boolean) => void)(true);
    (propsOf(lineupPanel()).onClose as () => void)();
    expect(showingLineup(), "X over unsaved edits does not close").toBe(true);
    expect(byTestid("lineup-discard-prompt"), "the in-page prompt shows").toHaveLength(1);
    // Keep editing
    (propsOf(byTestid("lineup-discard-keep")[0]!).onClick as () => void)();
    expect(byTestid("lineup-discard-prompt")).toHaveLength(0);
    expect(showingLineup()).toBe(true);
    // another panel's button is held the same way
    pressBar("rules");
    expect(byTestid("lineup-discard-prompt")).toHaveLength(1);
    expect(showingLineup()).toBe(true);
    // Discard: goes where the click was headed, and the editors are remounted from their saved lineups
    (propsOf(byTestid("lineup-discard-confirm")[0]!).onClick as () => void)();
    expect(showingLineup()).toBe(false);
    expect(byTestid("lineup-discard-prompt")).toHaveLength(0);
    const rules = tree().find((e) => typeof e.type === "function" && propsOf(e).panel === "rules" && typeof propsOf(e).closeLabel === "string")!;
    expect(propsOf(rules).hidden, "Match rules is the open one").not.toBe(true);
    expect(keysBefore.length, "anti-vacuity: the editors' wrappers were keyed").toBeGreaterThan(0);
    const keysAfter = tree().filter((e) => e.key !== null && String(e.key).startsWith("e1-")).map((e) => String(e.key));
    expect(keysAfter).not.toEqual(keysBefore);
    island.unmount();
  });
});
