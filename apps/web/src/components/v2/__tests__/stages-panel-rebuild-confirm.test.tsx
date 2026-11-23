// Owner-approved 2026-11-09 (W4 app PR A fix round): Rebuild's confirm says where times and courts go. Rebuild carries
// every slot an organiser laid out by the match's place (lib/rebuild-slots.ts `carrySlots`: (pool, round, seq) for every
// kind; a knockout by bracket role since W4 T4, a stepladder and a page playoff since T26c), so the dialog says so before
// the organiser presses it. Drives the real island (the hook harness): the roster-drift banner's Rebuild button, the
// confirm it opens, captured.
//
// Expected: the owner's sentence, typed out here (never read off the panel). Swept over the five kinds the sentence is
// TRUE for — a knockout, a stepladder and a page playoff (carry by role) and a league and a Swiss (carry by position) —
// one sentence for all, because the carry runs for every kind (usecases/stages/generate-tx.ts `regenerateStageInTx`). NOT swept: a double
// elimination, whose Rebuild still carries by position, so a rebuilt grand final does not keep the grand final's slot
// and the sentence is false for it (owed to W6, W6-double-elim.md "Carried from W4"). Sport-free: the dialog reads no
// sport field.
import { describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { StagesPanel } from "@/components/v2/stages-panel";
import { windowRunSheet } from "@/lib/run-sheet-paging";

const confirmCalls = vi.hoisted(() => [] as { title?: string; body?: string }[]);
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () =>
    vi.fn(async (opts: { title?: string; body?: string }) => {
      confirmCalls.push(opts);
      return false; // declined: the test reads the dialog, not the write
    }),
}));
// The panel reads on mount (its effects): every call answers an empty body.
vi.mock("@/lib/client-v1", async (importOriginal) => ({ ...(await importOriginal<object>()), apiV1: vi.fn(async () => ({})) }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(""),
}));

const OWNER_SENTENCE = "Times and courts stay with each match's place in the draw.";
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function props(kind: string, config: Record<string, unknown>) {
  return {
    divisionId: "d1",
    competitionId: "c1",
    orgSlug: "org",
    compSlug: "comp",
    divSlug: "div",
    tz: "UTC",
    orgTz: "UTC",
    canExport: false,
    viewerPlan: "community" as const,
    entrantNames: { e1: "E1", e2: "E2" },
    activeEntrantIds: ["e1", "e2"],
    entrantSeeds: { e1: 1, e2: 2 },
    canEdit: true,
    stages: [{ id: "s1", seq: 1, kind, name: "Stage", config, progression: null, status: "active" }],
    fixtures: [],
    rosterDrift: { s1: { ghosts: [{ id: "e9", display_name: "Gone Gus" }], unplaced: [] } },
  };
}

describe("Rebuild's confirm says times and courts stay with each match's place", () => {
  it("the empty case first: nothing pressed, no dialog", () => {
    confirmCalls.length = 0;
    renderIsland(StagesPanel, props("knockout", {}));
    expect(confirmCalls).toHaveLength(0);
  });

  it("a knockout, a stepladder, a page playoff, a league and a Swiss: the dialog carries the owner's sentence, before the can't-undo line", async () => {
    let checked = 0;
    for (const [kind, config] of [
      ["knockout", {}],
      ["stepladder", {}],
      ["page_playoff", {}],
      ["league", { legs: 1 }],
      ["swiss", { rounds: 3 }],
    ] as const) {
      confirmCalls.length = 0;
      const island = renderIsland(StagesPanel, props(kind, config));
      await flush();
      const btn = island.tree().filter((el) => propsOf(el)["data-testid"] === "roster-drift-rebuild");
      expect(btn, `${kind}: premise, the Rebuild button is rendered`).toHaveLength(1);
      (propsOf(btn[0]!).onClick as () => void)();
      await flush();
      expect(confirmCalls, `${kind}: one dialog`).toHaveLength(1);
      const body = confirmCalls[0]!.body ?? "";
      expect(body, `${kind}: the sentence`).toContain(OWNER_SENTENCE);
      expect(body.indexOf(OWNER_SENTENCE), `${kind}: said before "This can't be undone."`).toBeLessThan(body.indexOf("This can't be undone."));
      checked++;
    }
    expect(checked, "anti-vacuity: five kinds").toBe(5);
  });
});

// W5 follow-ups C, review I2: a big division's desk holds only the window's rows plus a TALLY of its folded rounds
// (`lib/run-sheet-paging.ts`), so the confirm's "deletes N fixtures" read the window - "35" over a stage that deletes 4,970. The
// expected sentence is the whole list's own render (the panel as it was before windowing), never a number typed here.
describe("review I2: a windowed stage's Rebuild confirm counts EVERY fixture, folded rounds included", () => {
  /** A 22-player single league (231 lines, over the paging line): rounds 1-5 played, 6-21 to come. */
  function league() {
    const NOW = Date.now();
    const rows = [];
    let n = 0;
    for (let round = 1; round <= 21; round++) {
      for (let seq = 1; seq <= 11; seq++) {
        n += 1;
        const done = round <= 5;
        rows.push({
          id: `f${n}`, division_id: "d1", stage_id: "s1", pool_id: null, fixture_no: n, round_no: round, seq_in_round: seq,
          status: done ? "decided" : "scheduled", scheduled_at: new Date(NOW + (round - 6) * 7 * 86_400_000).toISOString(),
          home_entrant_id: `e${seq}`, away_entrant_id: `e${seq + 11}`, outcome: done ? { kind: "win", winner: `e${seq}` } : null,
          home_slot_label: null, away_slot_label: null, court_id: null, court_name: null, venue_name: null, officials: [], lane: null,
          is_final: false, third_place: false, conditional: false, ext_key: null,
        });
      }
    }
    return { rows, NOW };
  }
  async function confirmBody(extra: Record<string, unknown>) {
    confirmCalls.length = 0;
    const island = renderIsland(StagesPanel, { ...props("league", { legs: 1 }), ...extra } as never);
    await flush();
    const btn = island.tree().filter((el) => propsOf(el)["data-testid"] === "roster-drift-rebuild");
    expect(btn, "premise: the Rebuild button is rendered").toHaveLength(1);
    (propsOf(btn[0]!).onClick as () => void)();
    await flush();
    expect(confirmCalls).toHaveLength(1);
    return confirmCalls[0]!.body ?? "";
  }

  it("the windowed desk's confirm says what the whole list's says", async () => {
    const { rows, NOW } = league();
    const w = windowRunSheet(rows, [{ id: "s1", kind: "league" }], { held: new Set(), nowMs: NOW, matchMinutes: 60, tz: "UTC" });
    expect(w.folded.length, "premise: rounds fold").toBeGreaterThan(10);
    expect(w.shipped.length, "premise: the window ships a fraction").toBeLessThan(rows.length / 4);
    const whole = await confirmBody({ fixtures: rows });
    const windowed = await confirmBody({ fixtures: w.shipped, foldedRounds: w.folded });
    const shippedOnly = await confirmBody({ fixtures: w.shipped });
    expect(shippedOnly, "premise: the count differs between the window and the whole list").not.toBe(whole);
    expect(windowed).toBe(whole);
  });
});

