// W5 app-A Task 23 (X-CU-7, X-CU-8, X-CU-11, X-CU-12; R24 picks 1A, 2A, 3A, 7A): the desk and public UI for a late player
// joining a running ROOT league or group.
//
//   X-CU-11  the Entrants tab's add form: the purple note, and on a group of several pools the Group field — defaulting to the
//            smallest (the server's own `choosePool`, carried as `defaultKey`), riding the ONE add as `late_entry_pool`;
//   X-CU-7   the rail's More offers "Add late player" on a started root league / group with fixtures, never on a fed table;
//            the board's round bar and the public round view tag an APPENDED catch-up round ("Catch-up"), keeping its number;
//   X-CU-12  the desk's Needs-you "unscheduled" row says how many of those are catch-up matches;
//   X-CU-8   the table card's waiting strip: one "Add to the table" per waiting player, posting T6's place route with the pool;
//            the Needs-you row lands on it (`#table-waiting`).
//
// Driven through the real components: islands through the shared node-env hook harness (their own handlers, a mocked wire),
// static ones through `renderToStaticMarkup`. Expected copy is the approved English typed out here (R24 page, the T23
// rulings), never read off the component. Node env (no DOM, AGENTS.md class 2): what a WIDTH shows is proven in e2e; here the
// control sets are pinned as ONE DOM — the same membership and order at 320, 768 and 1280, nothing hidden per width.
// Single-sport by nature: these surfaces read stage kind / status, pools and ext keys; no sport field reaches them.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ReactNode } from "react";
import { propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => { router.refreshCount += 1; }, push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(""),
}));
const router = vi.hoisted(() => ({ refreshCount: 0 }));
const confirms = vi.hoisted(() => ({ asked: [] as { title?: string; body?: string; confirmLabel?: string }[], answer: true }));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => async (o: { title?: string; body?: string; confirmLabel?: string }) => {
    confirms.asked.push(o);
    return confirms.answer;
  },
}));
vi.mock("@/lib/entrant-badge", () => ({ resolveEntrantBadge: () => null }));
const net = vi.hoisted(() => ({ calls: [] as { url: string; method?: string; json?: unknown }[], answers: [] as (() => unknown)[] }));
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: (url: string, options?: { method?: string; json?: unknown }) => {
      if (url.startsWith("/api/v1/persons?")) return Promise.resolve({ items: [], nextCursor: null });
      // The panel's own reads on mount (GETs) are not what these tests witness; only the writes are recorded and answered.
      if (options?.method === undefined || options.method === "GET") return Promise.resolve([]);
      net.calls.push({ url, method: options?.method, json: options?.json });
      const next = net.answers.shift();
      if (!next) return Promise.reject(new Error(`no answer queued for ${url}`));
      try {
        return Promise.resolve(next());
      } catch (e) {
        return Promise.reject(e);
      }
    },
  };
});

const { ApiV1Error } = await import("@/lib/client-v1");
import en from "@/dictionaries/en/ui.json";
import enPublic from "@/dictionaries/en/public.json";
import type { Dict } from "@/lib/i18n-constants";
import type { EffectiveEntrantModel } from "@seazn/engine/sport";
import { EntrantsPanel, type EntrantsPanelEligibility } from "@/components/v2/entrants-panel";
import { TableLatePoolSelect } from "@/components/v2/table-late-pool-select";
import { TableWaitingStrip } from "@/components/v2/desk/table-waiting-strip";
import { StageRail, type StageRailProps } from "@/components/v2/desk/stage-rail";
import { needsYouItems } from "@/components/v2/desk/needs-you";
import { DictProvider } from "@/components/i18n/dict-provider";
import { RunSheet } from "@/components/v2/desk/run-sheet";
import { buildRunSheet, type RunSheetFixture } from "@/lib/run-sheet-groups";
import { Schedule, type ScheduleCopy } from "@/components/public-site/schedule";
import type { PublicFixture } from "@/server/public-site/data";
import type { CompetitionDesk, DeskDivision } from "@/server/usecases/competition-desk";
import type { TableLatePool } from "@/server/usecases/table-desk";

beforeEach(() => {
  net.calls = [];
  net.answers = [];
  router.refreshCount = 0;
  confirms.asked = [];
  confirms.answer = true;
});
const flush = () => new Promise((r) => setTimeout(r, 0));
const byTestId = (tree: ReactElement[], id: string) => tree.filter((e) => propsOf(e)["data-testid"] === id);

// Three pools, B the smallest (3 entrants, so a newcomer owes 3) — what `readTableLatePools` answers for a 4/3/4 group.
const POOLS: TableLatePool[] = [
  { key: "A", size: 4, owes: 4 },
  { key: "B", size: 3, owes: 3 },
  { key: "C", size: 4, owes: 4 },
];

// ─── X-CU-11: the add form's Group field ────────────────────────────────────────────────────────────────────────────────────
const NO_ELIGIBILITY: EntrantsPanelEligibility = { category: null, age_min: null, age_max: null, eligibility_note: null };
const MODEL: EffectiveEntrantModel = { kinds: ["individual"], defaultKind: "individual", squadNumbers: false, captain: false, maxTeamMembers: null };
const entrant = (id: string, display_name: string) => ({ id, division_id: "div-1", kind: "individual", display_name, seed: null, status: "confirmed", members: [] });

function entrantsTab(tableLateEntry: unknown) {
  const island = renderIsland(EntrantsPanel, {
    divisionId: "div-1",
    entrants: [entrant("e1", "Ana"), entrant("e2", "Ben")],
    canEdit: true,
    positionGroups: [],
    roles: [],
    eligibility: NO_ELIGIBILITY,
    entrantModel: MODEL,
    viewerPlan: "community" as const,
    divisionStatus: "active",
    tableLateEntry,
  } as never);
  const form = () => {
    const el = island.tree().find((e) => propsOf(e).importControls !== undefined);
    if (!el) throw new Error("no add form");
    return el;
  };
  /** The Group field the form carries — the `TableLatePoolSelect` element inside its `poolField`, or null. */
  const field = () => walk(propsOf(form()).poolField as ReactNode).find((e) => e.type === TableLatePoolSelect) ?? null;
  const add = async () => {
    net.answers.push(() => entrant("e9", "Westgate Wanderers"));
    await (propsOf(form()).onSubmit as (p: Record<string, unknown>) => Promise<unknown>)({ kind: "individual", display_name: "Westgate Wanderers" });
    await flush();
  };
  return { island, form, field, add, notes: () => island.tree().filter((e) => propsOf(e)["data-testid"] === "entrants-table-late-note").map((e) => textOf([e])) };
}

describe("X-CU-11 the Entrants tab's add form for a running league or group", () => {
  it("X-CU-11 the add form shows the pool picker for a running group, defaulting to the smallest pool", async () => {
    const tab = entrantsTab({ kind: "group", pools: POOLS, defaultKey: "B" });
    expect(tab.notes()).toEqual(["This group stage has started. An entrant you add here joins a group and plays catch-up matches."]);
    const field = tab.field();
    expect(field, "the form carries the Group field").not.toBeNull();
    expect(propsOf(field!).value, "it opens at the smallest pool").toBe("B");

    // What the organiser reads in it: every pool, in the stage's order, each with its cost; the smallest marked once.
    const html = renderToStaticMarkup(field!);
    const options = [...html.matchAll(/<option[^>]*value="([^"]+)"[^>]*>([^<]*)<\/option>/g)].map((m) => [m[1], m[2]!.replace(/&#x27;/g, "'")]);
    expect(options).toEqual([
      ["A", "Group A · 4 entrants · 4 matches to play"],
      ["B", "Group B · 3 entrants · 3 matches to play · smallest"],
      ["C", "Group C · 4 entrants · 4 matches to play"],
    ]);
    expect(html).toContain(">Group</label>");

    // Fix round 1 m1: left alone, the add names NO pool — the server's own `choosePool` decides at the moment of the add (the
    // read the field opened at may be stale by then). Only the organiser's pick rides the ONE add body.
    await tab.add();
    expect(net.calls.map((c) => c.url)).toEqual(["/api/v1/divisions/div-1/entrants"]);
    expect(net.calls[0]!.json, "untouched: no pool named").not.toHaveProperty("late_entry_pool");
  });

  it("m1 picking the default Group B by hand sends B: a choice the organiser made is sent, even when it matches the default", async () => {
    const tab = entrantsTab({ kind: "group", pools: POOLS, defaultKey: "B" });
    (propsOf(tab.field()!).onChange as (k: string) => void)("B");
    await tab.add();
    expect((net.calls[0]!.json as { late_entry_pool?: string }).late_entry_pool).toBe("B");
  });

  it("a second add after picking Group C sends C (the pick is state, not the default)", async () => {
    const tab = entrantsTab({ kind: "group", pools: POOLS, defaultKey: "B" });
    (propsOf(tab.field()!).onChange as (k: string) => void)("C");
    expect(propsOf(tab.field()!).value).toBe("C");
    await tab.add();
    await tab.add();
    expect(net.calls.map((c) => (c.json as { late_entry_pool?: string }).late_entry_pool)).toEqual(["C", "C"]);
  });

  it("the empty cases first: a league, a one-pool group and a division taking no table late entry show no Group field", async () => {
    const ROWS: { name: string; arg: unknown; note: string | null }[] = [
      { name: "a league", arg: { kind: "league", pools: [], defaultKey: null }, note: "This league has started. An entrant you add here plays catch-up matches against everyone in it." },
      { name: "a one-pool group", arg: { kind: "group", pools: [{ key: "A", size: 5, owes: 5 }], defaultKey: null }, note: "This group stage has started. An entrant you add here joins a group and plays catch-up matches." },
      { name: "no table late entry", arg: null, note: null },
    ];
    let checked = 0;
    for (const r of ROWS) {
      net.calls = [];
      const tab = entrantsTab(r.arg);
      expect(tab.notes(), r.name).toEqual(r.note === null ? [] : [r.note]);
      expect(tab.field(), r.name).toBeNull();
      await tab.add();
      expect(net.calls.length, `${r.name}: positive pair, the add posted`).toBe(1);
      expect(net.calls[0]!.json, r.name).not.toHaveProperty("late_entry_pool");
      checked++;
    }
    expect(checked).toBe(3);
  });
});

// ─── X-CU-7: the rail's "Add late player" ───────────────────────────────────────────────────────────────────────────────────
const HREF = "/o/club/c/open/d/main?tab=entrants#add-entrant";
const NEUTRAL = {
  counts: { played: 0, inPlay: 0, unplayed: 4 },
  matchCount: 4,
  open: false,
  onToggleOpen: () => {},
  swissHasUnseated: false,
  canUnpairSwiss: false,
  swissPairingMenu: null,
};
type Row = { id: string; name: string; kind: string; seq: number; status: string; progression: unknown; config: unknown };
const st = (o: Partial<Row>): Row => ({ id: "s1", name: "Stage", kind: "league", seq: 1, status: "active", progression: null, config: {}, ...o });
function rail(stage: Row, division: Row[], divisionStatus: string, fixtureCount = 6, extra: Partial<StageRailProps> = {}) {
  return renderToStaticMarkup(
    <StageRail stage={stage as never} canEdit busy={null} fixtureCount={fixtureCount} deletable={false}
      onAct={async () => true} onDelete={() => {}} addingTo={null} onToggleAddMatch={() => {}} adhoc={false} {...NEUTRAL}
      lateEntry={{ divisionStatus, roundSeated: false, href: HREF, division }} {...extra} />,
  );
}

describe("X-CU-7 the rail offers Add late player on a running root table", () => {
  it("X-CU-7 stage-add-late-player is offered for a running league and not for a fed knockout", () => {
    const league = st({ kind: "league" });
    const html = rail(league, [league], "active");
    expect(html).toContain('data-testid="stage-add-late-player"');
    expect(html).toContain(`href="${HREF}"`);
    expect(html).toContain(">Add late player<");
    expect(html, "a table is not a bracket").not.toContain("Add to bracket");

    const group = st({ id: "g", kind: "group" });
    const fedKo = st({ id: "k", kind: "knockout", seq: 2, progression: { from: "g", top: 2 } });
    const fed = rail(fedKo, [group, fedKo], "active");
    expect(fed, "positive pair: the fed knockout's rail rendered").toContain('data-testid="stage-rail-trigger"');
    expect(fed).not.toContain('data-testid="stage-add-late-player"');
  });

  it("a running root group offers it too; a table before Start, without fixtures, finished or fed never does", () => {
    const group = st({ id: "g", kind: "group" });
    expect(rail(group, [group], "active")).toContain('data-testid="stage-add-late-player"');
    const feeder = st({ id: "g0", kind: "group", status: "complete" });
    const fedLeague = st({ id: "l", kind: "league", seq: 2, progression: { from: "g0", top: 2 } });
    const ROWS: { name: string; html: string }[] = [
      { name: "before Start (setup)", html: rail(st({ status: "pending" }), [st({ status: "pending" })], "setup") },
      { name: "no fixtures drawn", html: rail(st({}), [st({})], "active", 0) },
      { name: "a finished league", html: rail(st({ status: "complete" }), [st({ status: "complete" })], "active") },
      { name: "a league fed by a group stage", html: rail(fedLeague, [feeder, fedLeague], "active") },
    ];
    let checked = 0;
    for (const r of ROWS) {
      expect(r.html, `${r.name}: positive pair`).toContain('data-testid="stage-rail-trigger"');
      expect(r.html, r.name).not.toContain('data-testid="stage-add-late-player"');
      checked++;
    }
    expect(checked).toBe(4);
  });
});

// ─── X-CU-12: the desk's catch-up flag ──────────────────────────────────────────────────────────────────────────────────────
const deskDiv = (attention: DeskDivision["attention"]): DeskDivision => ({
  phase: "match_day", attention, played: 4, total: 10, unscheduled: 3, in_play: 0, entrants: 5, next: null, needs_draw_stage: null,
  fixture_names: {}, display_tz: "UTC",
} as DeskDivision);
const deskOf = (d: DeskDivision): CompetitionDesk => ({ in_play: 0, in_play_fixtures: [], up_next: null, fixtures_today: 0, divisions: new Map([["d1", d]]), now: "2026-11-18T09:00:00Z" });
const DIVS = [{ id: "d1", name: "Premier", slug: "premier" }];

describe("X-CU-12 / X-CU-8 the competition page's Needs-you rows", () => {
  it("X-CU-12 the desk shows the unscheduled catch-up flag", () => {
    const [item] = needsYouItems(en as Dict, deskOf(deskDiv([{ kind: "unscheduled", count: 3, catchUp: 2 }])), DIVS, "org", "comp", "en");
    expect(item!.title).toBe("Premier · 3 fixtures unscheduled");
    expect(item!.sub).toBe("No time or pitch yet. The slideshow shows them as TBC. 2 of them are late entrants' catch-up matches.");
    const one = needsYouItems(en as Dict, deskOf(deskDiv([{ kind: "unscheduled", count: 3, catchUp: 1 }])), DIVS, "org", "comp", "en")[0]!;
    expect(one.sub).toBe("No time or pitch yet. The slideshow shows them as TBC. 1 of them is a late entrant's catch-up match.");
  });

  it("the empty case: no catch-up (absent or zero) says the plain row", () => {
    let checked = 0;
    for (const a of [{ kind: "unscheduled" as const, count: 3 }, { kind: "unscheduled" as const, count: 3, catchUp: 0 }]) {
      const [item] = needsYouItems(en as Dict, deskOf(deskDiv([a])), DIVS, "org", "comp", "en");
      expect(item!.sub).toBe("No time or pitch yet. The slideshow shows them as TBC.");
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("X-CU-8 the table's waiting row lands on the strip; the knockout's keeps its tab", () => {
    const table = needsYouItems(en as Dict, deskOf(deskDiv([{ kind: "late_players_waiting", count: 1, stageName: "League", table: true }])), DIVS, "org", "comp", "en")[0]!;
    expect(table.action?.href).toBe("/o/org/c/comp/d/premier?tab=fixtures#table-waiting");
    const ko = needsYouItems(en as Dict, deskOf(deskDiv([{ kind: "late_players_waiting", count: 1, stageName: "Cup" }])), DIVS, "org", "comp", "en")[0]!;
    expect(ko.action?.href).toBe("/o/org/c/comp/d/premier?tab=fixtures");
  });
});

// ─── X-CU-8: the waiting strip and its tap ──────────────────────────────────────────────────────────────────────────────────
const STAGE = "stage-1";
const WES = { entrantId: "e-wes", stageId: STAGE, name: "Westgate Wanderers Badminton Club Second Team", paid: false };
const IVY = { entrantId: "e-ivy", stageId: STAGE, name: "Ivy", paid: true };
const REGISTRATIONS = "/o/club/c/open/registration?tab=registrants&division_id=d1";
function strip(o: { pools?: TableLatePool[]; defaultPool?: string | null; waiting?: typeof WES[]; rebuildable?: boolean; fixtureCount?: number } = {}) {
  const placed: { done: string[]; todo: string[] }[] = [];
  const island = renderIsland(TableWaitingStrip, {
    stageId: STAGE,
    waiting: o.waiting ?? [WES, IVY],
    names: { "e-ana": "Ana" },
    pools: o.pools,
    defaultPool: o.defaultPool ?? null,
    rebuildable: o.rebuildable ?? false,
    fixtureCount: o.fixtureCount ?? 0,
    registrationsHref: REGISTRATIONS,
    onPlaced: (said: { done: string[]; todo: string[] }) => placed.push(said),
  } as never);
  const tap = async (i = 0) => {
    const btn = byTestId(island.tree(), "table-waiting-place")[i];
    if (!btn) throw new Error(`no tap ${i}`);
    (propsOf(btn).onClick as () => void)();
    await flush();
  };
  const rebuild = async (i = 0) => {
    const btn = byTestId(island.tree(), "table-waiting-rebuild")[i];
    if (!btn) throw new Error(`no Rebuild ${i}`);
    (propsOf(btn).onClick as () => void)();
    await flush();
    await flush();
  };
  return { island, placed, tap, rebuild };
}
const catchUp = (pool: string | undefined) => ({
  format: "group", entrant_id: "e-wes", stage_id: STAGE, source: "organiser", case: "catch_up", pool_key: pool,
  fixtures: [6, 7, 8].map((r) => ({ fixture_id: `f${r}`, round_no: r, placement: "catch_up_round", scheduled: false })), appended_rounds: 3,
});

describe("X-CU-8 the table card's waiting strip", () => {
  it("X-CU-8 the waiting flag offers the tap", async () => {
    const s = strip({ pools: POOLS, defaultPool: "B" });
    const tree = s.island.tree();
    expect(byTestId(tree, "table-waiting")[0] && propsOf(byTestId(tree, "table-waiting")[0]!).id, "the Needs-you anchor").toBe("table-waiting");
    expect(textOf(byTestId(tree, "table-waiting-row")), "each waiting player is named").toContain(WES.name);
    expect(byTestId(tree, "table-waiting-place").map((b) => textOf([b]))).toEqual(["Add to the table", "Add to the table"]);
    const pickers = tree.filter((e) => e.type === TableLatePoolSelect);
    expect(pickers.map((p) => propsOf(p).value), "each row's Group opens at the smallest").toEqual(["B", "B"]);

    // The tap: T6's place route, with the row's pool; the answer is said in the panel's lines, and the page re-read.
    net.answers.push(() => catchUp("B"));
    await s.tap(0);
    // m1 (applied to the strip too): left at the default, the tap names no pool — the server's `choosePool` decides at the tap.
    expect(net.calls).toEqual([{ url: `/api/v1/stages/${STAGE}/late-entrants/e-wes/place`, method: "POST", json: {} }]);
    expect(s.placed).toEqual([
      {
        done: [`${WES.name} joined Group B.`, `${WES.name} has 3 catch-up matches, in rounds 6, 7, and 8.`],
        todo: [
          "3 new matches have no time or court yet. Give each one a time and court.",
          "Their opponents are not notified. Tell them about the new matches.",
          "Adding a late player can't be undone. Withdraw the player instead.",
        ],
      },
    ]);
    expect(router.refreshCount).toBe(1);
  });

  it("a second tap on another row after picking Group A sends A for that row only", async () => {
    const s = strip({ pools: POOLS, defaultPool: "B" });
    const pickers = s.island.tree().filter((e) => e.type === TableLatePoolSelect);
    (propsOf(pickers[1]!).onChange as (k: string) => void)("A");
    net.answers.push(() => catchUp("B"), () => ({ ...catchUp("A"), entrant_id: "e-ivy" }));
    await s.tap(0);
    await s.tap(1);
    expect(net.calls.map((c) => c.json)).toEqual([{}, { pool_key: "A" }]);
  });

  it("a league (no pools) posts no pool; a refused tap says why under the row and leaves the exits", async () => {
    const s = strip({ waiting: [IVY] });
    expect(s.island.tree().filter((e) => e.type === TableLatePoolSelect)).toEqual([]);
    net.answers.push(() => {
      throw new ApiV1Error("finished", 409, "RR_LATE_ENTRY_STAGE_COMPLETE");
    });
    await s.tap(0);
    expect(net.calls[0]!.json).toEqual({});
    const tree = s.island.tree();
    expect(textOf(byTestId(tree, "table-waiting-outcome"))).toContain("This table has finished. Late players can't join it.");
    expect(byTestId(tree, "table-waiting-withdraw")).toHaveLength(1);
    expect(byTestId(tree, "table-waiting-refund").map((l) => propsOf(l).href), "a paid entry's refund").toEqual([REGISTRATIONS]);
    expect(s.placed).toEqual([]);
  });

  it("the empty case: nobody waiting draws no strip", () => {
    expect(strip({ waiting: [] }).island.tree()).toEqual([]);
  });

  it("control set: the same controls in the same order at 320, 768 and 1280 — one DOM, nothing hidden per width", () => {
    const html = renderToStaticMarkup(
      <TableWaitingStrip stageId={STAGE} waiting={[WES]} names={{}} pools={POOLS} defaultPool="B" registrationsHref={REGISTRATIONS} onPlaced={() => {}} />,
    );
    const controls = [...html.matchAll(/<(button|select|a)\b[^>]*data-testid="([^"]+)"[^>]*>/g)];
    expect(controls.map((m) => m[2])).toEqual(["table-waiting-pool", "table-waiting-place"]);
    // m3: the row's Group field is named for the player it places, for a screen reader (the row shows the name beside it).
    expect(html).toContain(`<label for="table-waiting-pool-e-wes" class="sr-only">Group for ${WES.name.replace(/'/g, "&#x27;")}</label>`);
    let checked = 0;
    for (const width of [320, 768, 1280]) {
      for (const m of controls) {
        // A control hidden at one width would carry a `hidden` token behind a breakpoint; one DOM carries none.
        expect(m[0], `${width}: ${m[2]}`).not.toMatch(/\b(?:max-)?(?:sm|md|lg):hidden\b|\shidden"/);
        checked++;
      }
    }
    expect(checked).toBe(6);
    // The tap's target is a full-height row at a phone width and sits beside the field from `sm`.
    expect(html).toMatch(/data-testid="table-waiting-place"[^>]*class="[^"]*min-h-11[^"]*max-sm:w-full/);
  });
});

// ─── X-CU-7: the catch-up round tag, on the board and in the public round view ──────────────────────────────────────────────
function boardFx(no: number, round: number, ext_key: string | null): RunSheetFixture {
  return {
    id: `f${no}`, stage_id: "s1", fixture_no: no, round_no: round, seq_in_round: 1, scheduled_at: null, status: "scheduled",
    court_name: null, court_id: null, venue_name: null, officials: [], outcome: null, home_entrant_id: "e1", away_entrant_id: "e2",
    home_slot_label: null, away_slot_label: null, lane: null, is_final: false, third_place: false, conditional: false, ext_key,
  };
}
function board(fixtures: RunSheetFixture[]) {
  const stages = [{ id: "s1", seq: 1, kind: "league", name: "League" }];
  const nowMs = Date.UTC(2026, 10, 18, 12);
  return renderToStaticMarkup(
    <DictProvider dict={en as Dict} locale="en">
      <RunSheet blocks={buildRunSheet({ fixtures, stages, tz: "UTC", nowMs })} stages={stages} tz="UTC" orgTz="UTC" nowMs={nowMs}
        matchMinutes={60} entrantNames={{ e1: "Ana", e2: "Ben" }} canEdit hrefFor={(f) => `/f/${f.fixture_no}`} filter="all"
        onFilter={() => {}} stageId="s1" embedded />
    </DictProvider>,
  );
}
/** Each round bar's number and whether it carries the tag. */
const bars = (html: string) =>
  [...html.matchAll(/data-run-sheet-round="(\d+)"([^]*?)(?=data-run-sheet-round="\d+"|$)/g)].map((m) => [Number(m[1]), m[2]!.includes("data-run-sheet-round-catch-up")] as const);

describe("X-CU-7 a catch-up round keeps its number and says Catch-up", () => {
  it("the board tags the appended round only — a consumed bye's line plays in a round the draw already had", () => {
    const html = board([
      boardFx(1, 1, "rr-r1-c1-L1"),
      boardFx(2, 2, "rr-by-r2-c1-L1"),
      boardFx(3, 3, "rr-cu-r3-c1-L1"),
      boardFx(4, 4, "pB-rr-cu-r4-c1-L1"),
    ]);
    const got = bars(html);
    expect(got).toEqual([[1, false], [2, false], [3, true], [4, true]]);
    expect(html).toContain("Round 3");
    const tag = /<span data-run-sheet-round-catch-up="[^"]*">(.*?)<\/span>/.exec(html);
    expect(tag?.[1]?.replace(/<!-- -->/g, "")).toBe(" · Catch-up");
  });

  it("the empty case: a draw with no catch-up line tags nothing", () => {
    const got = bars(board([boardFx(1, 1, "rr-r1-c1-L1"), boardFx(2, 2, null)]));
    expect(got.length, "positive pair: two bars").toBe(2);
    expect(got.every(([, tagged]) => !tagged)).toBe(true);
  });

  it("the public round view tags the same round, in the public dictionary's word", () => {
    const COPY: ScheduleCopy = {
      timeTbd: "(time tbd)", allEntrants: "(all)", live: "(live)", ended: "(ended)", tbd: "(tbd)", held: "(held)",
      filterLabel: "(filter)", viewLabel: "(view)", viewDay: "(day)", viewRound: "(round)", calendar: "(calendar)",
      timesIn: "(times in {zone})", empty: "(empty)", roundOpened: "(opened)", catchUp: (enPublic as Record<string, string>)["division.catchUp"],
    };
    const pf = (no: number, round: number, ext_key: string | null) => ({
      id: `f${no}`, division_id: "d1", stage_id: "s1", pool_id: null, round_no: round, seq_in_round: 1, home_entrant_id: "e1",
      away_entrant_id: "e2", home_slot_label: null, away_slot_label: null, scheduled_at: null, venue: null, court_label: null,
      venue_name: null, court_name: null, status: "scheduled", outcome: null, summary: null, last_seq: null, ext_key,
    }) as PublicFixture;
    const fixtures = [pf(1, 1, "rr-r1-c1-L1"), pf(2, 2, "rr-cu-r2-c1-L1")];
    const html = renderToStaticMarkup(
      <Schedule fixtures={fixtures} entrantNames={{ e1: "Ana", e2: "Ben" }} divisionPath="/o/c/d" tz="UTC" slotLabels={{}}
        roundLabels={{ f1: "Round 1", f2: "Round 2" }} stageOrder={{ s1: 1 }} stageNames={{ s1: "League" }} copy={COPY} locale="en" />,
    );
    const tags = [...html.matchAll(/data-testid="schedule-catch-up"[^>]*>([^<]*)</g)].map((m) => m[1]);
    expect(tags).toEqual(["Catch-up"]);
    expect(html.indexOf("Round 2")).toBeLessThan(html.indexOf('data-testid="schedule-catch-up"'));
    expect(html.indexOf("Round 1"), "positive pair: round 1 rendered, untagged").toBeLessThan(html.indexOf("Round 2"));
  });
});

// ─── X-CU-8 (T23 ruling): a waiting player is the strip's, not the Rebuild banner's ─────────────────────────────────────────
describe("X-CU-8 the roster-drift banner leaves the waiting players to the strip", () => {
  it("the strip's player is dropped from 'not on a fixture yet'; with nothing left the banner is not drawn", async () => {
    const { withoutTableWaiting } = await import("@/components/v2/stages-panel");
    const { rosterDriftShown } = await import("@/lib/roster-drift-eligibility");
    const wes = { id: "e-wes", display_name: WES.name };
    const only = withoutTableWaiting({ ghosts: [], unplaced: [wes], vacantLines: 0 }, [WES]);
    expect(only?.unplaced).toEqual([]);
    expect(rosterDriftShown(only), "nothing left to say: no banner").toBe(false);
  });

  it("the positive pairs: a ghost, or an unplaced player who is NOT waiting, still shows", async () => {
    const { withoutTableWaiting } = await import("@/components/v2/stages-panel");
    const { rosterDriftShown } = await import("@/lib/roster-drift-eligibility");
    const wes = { id: "e-wes", display_name: WES.name };
    const ana = { id: "e-ana", display_name: "Ana" };
    const ROWS = [
      { name: "an unplaced player who is not waiting", d: { ghosts: [], unplaced: [wes, ana] }, unplaced: ["e-ana"] },
      { name: "a ghost beside the waiting player", d: { ghosts: [ana], unplaced: [wes] }, unplaced: [] },
    ];
    let checked = 0;
    for (const r of ROWS) {
      const out = withoutTableWaiting(r.d, [WES]);
      expect(out!.unplaced.map((e) => e.id), r.name).toEqual(r.unplaced);
      expect(rosterDriftShown(out), r.name).toBe(true);
      checked++;
    }
    expect(checked).toBe(2);
    // the empty cases: no drift, and nobody waiting, pass through untouched
    expect(withoutTableWaiting(undefined, [WES])).toBeUndefined();
    const d = { ghosts: [], unplaced: [wes] };
    expect(withoutTableWaiting(d, [])).toBe(d);
  });
});

// ─── Fix round 1 I1 (R24 7A made true): the strip's Rebuild exit, before any match has started ───────────────────────────────
const REBUILD_NOTE = (name: string) =>
  `No match in this stage has started yet. Rebuild fixtures on the stage card would draw it again with ${name} in it, instead of the catch-up matches.`;
describe("I1 the waiting strip offers a real Rebuild before any result", () => {
  it("the empty case first: once a match has started (rebuildable false) there is no Rebuild and no sentence pointing at one", () => {
    const s = strip({ waiting: [WES], rebuildable: false, fixtureCount: 10 });
    const tree = s.island.tree();
    expect(byTestId(tree, "table-waiting-rebuild")).toEqual([]);
    expect(byTestId(tree, "table-waiting-rebuild-note")).toEqual([]);
    expect(byTestId(tree, "table-waiting-place"), "positive pair: Place is still there").toHaveLength(1);
  });

  it("before any match: the 7A sentence and 'Rebuild fixtures' beside 'Add to the table'; the tap confirms with the count, then asks for the redraw", async () => {
    const s = strip({ waiting: [WES], pools: POOLS, defaultPool: "B", rebuildable: true, fixtureCount: 12 });
    const tree = s.island.tree();
    expect(textOf(byTestId(tree, "table-waiting-rebuild-note"))).toBe(REBUILD_NOTE(WES.name));
    expect(byTestId(tree, "table-waiting-rebuild").map((b) => textOf([b]))).toEqual(["Rebuild fixtures"]);

    net.answers.push(() => ({ format: "group", entrant_id: "e-wes", stage_id: STAGE, source: "organiser", case: "rebuild_offered", reason: "rebuilt" }));
    await s.rebuild(0);
    expect(confirms.asked.map((c) => [c.title, c.confirmLabel])).toEqual([["Rebuild this stage's fixtures?", "Rebuild"]]);
    expect(confirms.asked[0]!.body, "the confirm says what it removes").toContain("It deletes 12 fixtures.");
    // The redraw re-snakes the pools: no pool is named, only the ask.
    expect(net.calls).toEqual([{ url: `/api/v1/stages/${STAGE}/late-entrants/e-wes/place`, method: "POST", json: { prefer_rebuild: true } }]);
    expect(s.placed).toEqual([{ done: [`${WES.name} is in: the stage was drawn again with them in it.`], todo: [] }]);
    expect(router.refreshCount).toBe(1);
  });

  it("a declined confirm sends nothing; a stale Rebuild (a match started meanwhile) is refused under the row and the page re-read", async () => {
    const s = strip({ waiting: [WES], rebuildable: true, fixtureCount: 10 });
    confirms.answer = false;
    await s.rebuild(0);
    expect(net.calls).toEqual([]);
    confirms.answer = true;
    net.answers.push(() => {
      throw new ApiV1Error("started", 409, "STAGE_HAS_RESULTS");
    });
    await s.rebuild(0);
    expect(textOf(byTestId(s.island.tree(), "table-waiting-outcome"))).toContain(
      `A match in this stage has started, so it can't be drawn again. Add ${WES.name} to the table instead.`,
    );
    expect(s.placed).toEqual([]);
    expect(router.refreshCount).toBe(1);
  });

  it("control set with the exit: the same three controls in the same order at every width (one DOM)", () => {
    const html = renderToStaticMarkup(
      <TableWaitingStrip stageId={STAGE} waiting={[WES]} names={{}} pools={POOLS} defaultPool="B" rebuildable fixtureCount={12} registrationsHref={REGISTRATIONS} onPlaced={() => {}} />,
    );
    const controls = [...html.matchAll(/<(button|select|a)\b[^>]*data-testid="([^"]+)"[^>]*>/g)];
    expect(controls.map((m) => m[2])).toEqual(["table-waiting-pool", "table-waiting-place", "table-waiting-rebuild"]);
    for (const m of controls) expect(m[0]).not.toMatch(/\b(?:max-)?(?:sm|md|lg):hidden\b|\shidden"/);
    expect(html).toMatch(/data-testid="table-waiting-rebuild"[^>]*class="[^"]*min-h-11/);
  });
});

// ─── Fix round 1 m3: every pool tied for smallest is tagged ─────────────────────────────────────────────────────────────────
describe("m3 the Group field tags every pool tied for smallest", () => {
  const tags = (pools: TableLatePool[], defaultKey: string | null) => {
    const html = renderToStaticMarkup(
      <DictProvider dict={en as Dict} locale="en">
        <TableLatePoolSelect id="p" testId="p" pools={pools} value={defaultKey ?? ""} onChange={() => {}} />
      </DictProvider>,
    );
    return [...html.matchAll(/<option[^>]*value="([^"]+)"[^>]*>([^<]*)<\/option>/g)].filter((m) => m[2]!.endsWith(" · smallest")).map((m) => m[1]);
  };
  it("A and B tie at 3 (C has 4): both are tagged; one smallest is tagged alone", () => {
    expect(tags([{ key: "A", size: 3, owes: 3 }, { key: "B", size: 3, owes: 3 }, { key: "C", size: 4, owes: 4 }], "A")).toEqual(["A", "B"]);
    expect(tags(POOLS, "B")).toEqual(["B"]);
  });
});
