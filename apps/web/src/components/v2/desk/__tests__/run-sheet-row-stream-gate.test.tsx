// The run sheet's stream CHIP (spec 2026-09-30 §2, T6). The panel moved to the fixture page (T5); the row keeps only a
// small chip — "● Live" or "● Waiting for phone" — linking to that page with `?stream=open`. It is the division's path to
// Stop, so it must show on a billing-FROZEN page too (the F1 probes it replaces lived there): the organiser gate is the
// division PAGE's (`streamStates` is read only for the page-level `canEdit`, pinned in stream-checkout-return.test.tsx),
// never the row's own `canEdit`, which is `editable` (= canEdit && !frozen) and would hide the chip exactly where Stop
// matters most.
//
// Driven with `renderIsland` (no DOM here): the chip's props are read off the row's own element tree.
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderIsland, propsOf, textOf, walk } from "@/components/__tests__/_hook-harness";
import { RunSheetRow } from "@/components/v2/desk/run-sheet-row";
import { messages } from "@/lib/messages";
import type { RunSheetFixture } from "@/lib/run-sheet-groups";
import { ACTIVE_STATES, holdStateOf, type HoldState } from "@/server/relay/domain/session";
import { Fixture } from "@/server/api-v1/schemas";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(""),
}));

const TZ = "Europe/London";
const ORG_TZ = "UTC";
const NOW_MS = Date.UTC(2026, 8, 10, 12, 0, 0);
const ENTRANTS = { e1: "Alpha", e2: "Bravo" };
const HREF = "/o/a/c/b/d/c/f/7";
/** Every hold state a session that is UP reads as — `holdStateOf` over the domain's ACTIVE_STATES, never typed here
 *  (B3 fix round 1, Minor 3). */
const HOLD_STATES: readonly HoldState[] = [
  ...new Set(ACTIVE_STATES.map((s) => holdStateOf(s)).filter((h): h is HoldState => h !== null)),
];
/** Every fixture status the v1 contract declares (Minor 3: the typed list missed `forfeited`). */
const STATUSES: readonly string[] = Fixture.shape.status.options;
/** The chip's accessible name per state: its visible words plus the match (Minor 11) — from the dictionary. */
const NAME: Record<HoldState, string> = {
  live: messages["runsheet.stream.liveName"].replace("{match}", `Alpha ${messages["schedule.vs"]} Bravo`),
  waiting: messages["runsheet.stream.waitingName"].replace("{match}", `Alpha ${messages["schedule.vs"]} Bravo`),
};
/** The chip's label per state — from the dictionary, never typed here. */
const LABEL: Record<HoldState, string> = {
  live: messages["runsheet.stream.live"],
  waiting: messages["runsheet.stream.waiting"],
};

function fx(o: Partial<RunSheetFixture> = {}): RunSheetFixture {
  return {
    id: "f1",
    stage_id: "s1",
    fixture_no: 7,
    round_no: 1,
    seq_in_round: 1,
    scheduled_at: "2026-09-10T14:00:00.000Z",
    status: "in_play",
    court_name: null,
    court_id: null,
    venue_name: null,
    officials: [],
    outcome: null,
    home_entrant_id: "e1",
    away_entrant_id: "e2",
    home_slot_label: null,
    away_slot_label: null,
    lane: null,
    is_final: false,
    third_place: false,
    conditional: false,
    ext_key: null,
    ...o,
  };
}

function row(options: { canEdit?: boolean; streamState?: HoldState; fixture?: RunSheetFixture } = {}): ReactElement[] {
  return renderIsland(RunSheetRow, {
    fixture: options.fixture ?? fx(),
    href: HREF,
    tz: TZ,
    orgTz: ORG_TZ,
    nowMs: NOW_MS,
    canEdit: options.canEdit ?? true,
    entrantNames: ENTRANTS,
    streamState: options.streamState,
  }).tree();
}

const chipOf = (tree: ReactElement[]): ReactElement | undefined =>
  tree.find((el) => propsOf(el)["data-testid"] === "run-sheet-stream-chip");

/** The POSITIVE pair for every "absent" assertion: without it a blank render would satisfy them all. */
function expectRowRendered(tree: ReactElement[]): void {
  expect(
    tree.some((el) => propsOf(el).href === HREF),
    "the row itself did not render, so every negative assertion below is vacuous",
  ).toBe(true);
}

describe("the run sheet's stream chip (spec 2026-09-30 §2) — the path to Stop from the division", () => {
  it("each hold state renders its chip — its state, its own words, THIS fixture's page with ?stream=open, 44px tall on phone", () => {
    let checked = 0;
    for (const state of HOLD_STATES) {
      const chip = chipOf(row({ streamState: state }));
      expect(chip, `${state}: no chip`).toBeDefined();
      const p = propsOf(chip!);
      expect(p["data-state"], state).toBe(state);
      expect(p.href, state).toBe(`${HREF}?stream=open`);
      expect(String(p.className).split(/\s+/), `${state}: the phone tap floor`).toContain("max-md:min-h-11");
      expect(textOf(chip!).trim(), `${state}: the chip's words`).toBe(LABEL[state]);
      checked++;
    }
    expect(checked).toBe(HOLD_STATES.length);
    // The two states must read differently, or the words above could not tell a waiting phone from a live one.
    expect(LABEL.live).not.toBe(LABEL.waiting);
  });

  it("the chip's accessible name says WHICH match — its visible words first (label in name), then home vs away (Minor 11)", () => {
    let checked = 0;
    for (const state of HOLD_STATES) {
      const p = propsOf(chipOf(row({ streamState: state }))!);
      expect(p["aria-label"], state).toBe(NAME[state]);
      expect(String(p["aria-label"]).startsWith(LABEL[state]), `${state}: the visible words lead the name`).toBe(true);
      checked++;
    }
    expect(checked).toBe(HOLD_STATES.length);
    expect(checked, "anti-vacuity").toBeGreaterThan(0);
  });

  it("no session: no chip — and no stream toggle or in-row panel in ANY state (the mount moved to the fixture page)", () => {
    let checked = 0;
    for (const streamState of [undefined, ...HOLD_STATES]) {
      const tree = row({ streamState });
      expectRowRendered(tree);
      expect(tree.some((el) => propsOf(el)["data-testid"] === "fixture-stream-toggle"), `${streamState}: a toggle`).toBe(false);
      const names = tree.map((el) => (typeof el.type === "function" ? el.type.name : ""));
      expect(names.filter((n) => /^FixtureStream(Panel|Toggle)$/.test(n)), `${streamState}: an in-row stream mount`).toEqual([]);
      checked++;
    }
    expect(checked).toBe(1 + HOLD_STATES.length);
    const none = row({});
    expectRowRendered(none);
    expect(chipOf(none), "no session, no chip").toBeUndefined();
  });

  it("F1: a billing-FROZEN page (the row's canEdit is `editable`, false) still shows the chip — Stop must stay one tap away", () => {
    let checked = 0;
    for (const state of HOLD_STATES) {
      const chip = chipOf(row({ canEdit: false, streamState: state }));
      expect(chip, `${state}: a frozen page lost its path to Stop`).toBeDefined();
      expect(propsOf(chip!).href).toBe(`${HREF}?stream=open`);
      checked++;
    }
    expect(checked).toBe(HOLD_STATES.length);
  });

  // B3 fix round 1, item 3 (owner decision, option a; mockup of record claude.ai/artifact/T1qGaW9RSCVW3Sj7R2R6CC): on
  // phones the chip moves to LINE 2, beside the row action, so line 1 carries the entrant names in full. One DOM, no twin:
  // the chip's element lives in line 2's wrapper, and at ≥768 (where both wrappers are `md:contents`) `md:order-first` on
  // the chip and on the time cell puts it back between the time and the names — the desktop row unchanged.
  it("phone line 2: the chip lives in line 2's wrapper, after the phone meta line and before the row action — never in line 1", () => {
    let checked = 0;
    for (const state of HOLD_STATES) {
      const tree = row({ streamState: state });
      const line = (n: string) => tree.find((el) => propsOf(el)["data-row-line"] === n);
      expect(line("1"), "line 1's wrapper").toBeDefined();
      expect(line("2"), "line 2's wrapper").toBeDefined();
      const inLine = (n: string) => walk(line(n)!).some((el) => propsOf(el)["data-testid"] === "run-sheet-stream-chip");
      expect(inLine("2"), `${state}: the chip is on line 2`).toBe(true);
      expect(inLine("1"), `${state}: and not on line 1`).toBe(false);
      // Line 2's own order, as a phone renders it (flex, no order classes below md): meta text, chip, action.
      const two = walk(line("2")!);
      const at = (pred: (el: ReactElement) => boolean) => two.findIndex(pred);
      const meta = at((el) => el.type === "p");
      const chip = at((el) => propsOf(el)["data-testid"] === "run-sheet-stream-chip");
      const action = at((el) => propsOf(el)["data-row-action"] !== undefined);
      expect([meta, chip, action].every((i) => i >= 0), `${state}: meta ${meta}, chip ${chip}, action ${action}`).toBe(true);
      expect(meta < chip && chip < action, `${state}: meta < chip < action`).toBe(true);
      checked++;
    }
    expect(checked).toBe(HOLD_STATES.length);
  });

  it("≥768 unchanged: the chip and the time cell carry `md:order-first` (time, chip, then names and the action); nothing else in the row does", () => {
    const tokens = (el: ReactElement | undefined) => String(propsOf(el!).className ?? "").split(/\s+/);
    let checked = 0;
    for (const canEdit of [true, false]) {
      // canEdit on a scheduled TIMED fixture renders the EDITABLE time button (canEditFixtureTime); off, the plain span.
      const tree = row({ canEdit, streamState: "live", fixture: fx({ status: "scheduled" }) });
      const chip = chipOf(tree);
      const time = canEdit
        ? tree.find((el) => propsOf(el)["data-testid"] === "run-sheet-edit-time")
        : tree.find((el) => el.type === "span" && tokens(el).includes("w-14"));
      expect(time, `canEdit ${canEdit}: the time cell`).toBeDefined();
      expect(tokens(chip), "the chip leads with the time at ≥768").toContain("md:order-first");
      expect(tokens(time), `canEdit ${canEdit}: the time cell leads at ≥768`).toContain("md:order-first");
      const ordered = tree.filter((el) => tokens(el).includes("md:order-first"));
      expect(ordered.length, `canEdit ${canEdit}: exactly the time cell and the chip`).toBe(2);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("every fixture status carries the chip while its session is up — a stream outlives the whistle", () => {
    let checked = 0;
    for (const status of STATUSES) {
      expect(chipOf(row({ fixture: fx({ status }), streamState: "live" })), `${status} lost the chip`).toBeDefined();
      checked++;
    }
    expect(checked).toBe(STATUSES.length);
    expect(STATUSES, "anti-vacuity: the declared set includes the status the typed list missed").toContain("forfeited");
  });
});
